import MimeParser from 'emailjs-mime-parser';
import {stringToArrayBuffer, arrayBufferToString, utilConcatBuf} from 'pvutils';
import * as asn1js from 'asn1js';
import {
  AttributeTypeAndValue,
  SignedData,
  ContentInfo,
  OCSPRequest,
  GeneralName,
  RelativeDistinguishedNames,
  CertID,
  Extension,
  TBSRequest,
  Request,
} from 'pkijs';

import getResultPrototype from './resultPrototype';
import smimeSpecificationConstants from '../constants/smimeSpecificationConstants';
import smimeVerificationResultCodes from '../constants/smimeVerificationResultCodes';

import * as Base64lib from 'js-base64';

const base64 = Base64lib.Base64;

class SmimeVerificationService {
  constructor() {
    this.ocspReqBuffer = new ArrayBuffer(0);
  }

  /**
   * Verifies a passed rawMessage as a signed S/MIME message.
   * You should surround this with try/catch where it's called in case of unexpected exceptions that prohibit reaching
   * a conclusive result - in this case we should not persist the result.
   * The returned result object's message is meant to be displayed to the user and should not be too technical.
   * @param rawMessage Full MIME message. Preferably in binary form as this reduces the risk of encoding issues.
   * @param mailId String of mail id.
   * @returns {Promise}
   */
  verifyMessageSignature(rawMessage, mailId) {
    return new Promise(resolve => {
      const result = getResultPrototype();
      result.mailId = mailId;

      const parser = new MimeParser();
      parser.write(rawMessage);
      parser.end();

      // S/MIME signature must be in content node 2. Email content is in content node 1.
      const signatureNode = parser.getNode("2");

      if (!this.isValidSmimeEmail(parser.node, signatureNode)) {
        result.success = false;
        result.code = smimeVerificationResultCodes.CANNOT_VERIFY;
        result.message = 'Message is not digitally signed.';
        return resolve(result);
      }

      // Done with specification checks. Let's actually verify the message.

      let cmsSignedSimpl = null;
      let signerEmail = '';

      try {
        // Get signature buffer
        const signatureBuffer = utilConcatBuf(new ArrayBuffer(0), signatureNode.content);

        const asn1 = this.getAsn1TypeFromBuffer(signatureBuffer);

        cmsSignedSimpl = this.getSignedDataFromAsn1(asn1);
        const tbsThingy = new TBSRequest({tbs: cmsSignedSimpl.certificates[0].tbs});
        const ocspReqSimpl = new OCSPRequest({tbsRequest: tbsThingy});
        //region Put static variables
        ocspReqSimpl.tbsRequest.requestorName = new GeneralName({
          type: 4
          ,
          value: new RelativeDistinguishedNames({
            typesAndValues: [
              new AttributeTypeAndValue({
                type: "2.5.4.6", // Country name
                value: new asn1js.PrintableString({value: "DE"})
              }),
              new AttributeTypeAndValue({
                type: "2.5.4.3", // Common name
                value: new asn1js.BmpString({value: "Rocket Thingy"})
              })
            ]
          })
        });

        ocspReqSimpl.tbsRequest.requestList = [new Request({
          reqCert: new CertID({
            hashAlgorithm: cmsSignedSimpl.digestAlgorithms[0],
            issuerNameHash: new asn1js.OctetString({valueHex: cmsSignedSimpl.certificates[0].issuer.typesAndValues[3].value.valueBlock.valueHex}),
            // issuerKeyHash: new asn1js.OctetString({valueHex: }),
            serialNumber: new asn1js.Integer({valueHex: cmsSignedSimpl.certificates[0].serialNumber.valueBlock.valueHex})
          })
        })];

        ocspReqSimpl.tbsRequest.requestExtensions = [
          new Extension({
            extnID: "1.3.6.1.5.5.7.48.1.2", // ocspNonce
            extnValue: (new asn1js.OctetString({valueHex: this.nonceGenerator(32)})).toBER(false)
          })
        ];
        //endregion

        //region Encode OCSP request and put on the Web page
        this.ocspReqBuffer = ocspReqSimpl.toSchema(true).toBER(false);
        //endregion

        const resultString = `${base64.encode(arrayBufferToString(this.ocspReqBuffer))}`;
        console.log('resultString');
        console.log(resultString);

        // Get signer's email address from signature
        signerEmail = cmsSignedSimpl.certificates[0].subject.typesAndValues[0].value.valueBlock.value;
      }
      catch (ex) {
        console.log(ex);
        result.success = false;
        result.code = smimeVerificationResultCodes.FRAUD_WARNING;
        result.message = 'Fraud warning: Invalid digital signature.';
        return resolve(result);
      }

      // Get content of email that was signed. Should be entire first child node.
      const signedDataBuffer = stringToArrayBuffer(parser.nodes.node1.raw.replace(/\n/g, "\r\n"));

      // Verify the signed data
      cmsSignedSimpl.verify({signer: 0, data: signedDataBuffer, checkChain: true}).then(
        verificationResult => {
          result.signer = signerEmail;

          if (this.isVerificationFailed(verificationResult)) {
            result.success = false;
            result.code = smimeVerificationResultCodes.FRAUD_WARNING;
            result.message = "Fraud warning: Message failed verification with signature.";
            return resolve(result);
          }

          if (!this.isFromAddressCorrect(parser, signerEmail)) {
            result.success = false;
            result.code = smimeVerificationResultCodes.FRAUD_WARNING;
            result.message = 'Fraud warning: The "From" email address does not match the signature\'s email address.';
            return resolve(result);
          }

          result.success = true;
          result.code = smimeVerificationResultCodes.VERIFICATION_OK;
          result.message = `Message includes a valid digital signature for the sender.`;
          return resolve(result);
        }).catch(
        // eslint-disable-next-line no-unused-vars
        error => {
          console.log(error);
          result.success = false;
          result.code = smimeVerificationResultCodes.CANNOT_VERIFY;
          result.message = 'Message cannot be verified: Unknown error.';
          return resolve(result);
        }
      );
    });
  }


  isValidSmimeEmail(rootNode, signatureNode) {
    return rootNode.contentType &&
      rootNode.contentType.params &&
      rootNode._childNodes &&
      signatureNode &&
      this.isRootNodeContentTypeValueCorrect(rootNode) &&
      this.isRootNodeContentTypeProtocolCorrect(rootNode) &&
      this.isRootNodeContentTypeMicalgCorrect(rootNode) &&
      this.isSignatureNodeContentTypeValueCorrect(signatureNode);
  }

  isRootNodeContentTypeValueCorrect(rootNode) {
    return smimeSpecificationConstants.rootNodeContentTypeValue.indexOf(rootNode.contentType.value) !== -1;
  }

  isRootNodeContentTypeProtocolCorrect(rootNode) {
    return rootNode.contentType.params.protocol === smimeSpecificationConstants.rootNodeContentTypeProtocol;
  }

  isRootNodeContentTypeMicalgCorrect(rootNode) {
    return smimeSpecificationConstants.rootNodeContentTypeMessageIntegrityCheckAlgorithms.indexOf(rootNode.contentType.params.micalg) !== -1;
  }

  isSignatureNodeContentTypeValueCorrect(signatureNode) {
    return smimeSpecificationConstants.signatureNodeContentTypeValues.indexOf(signatureNode.contentType.value) !== -1;
  }

  getAsn1TypeFromBuffer(signatureBuffer) {
    const asn1 = asn1js.fromBER(signatureBuffer);
    if (asn1.offset === -1) {
      throw new TypeError('Could not parse signature.');
    }
    return asn1;
  }

  getSignedDataFromAsn1(asn1) {
    const cmsContentSimpl = new ContentInfo({schema: asn1.result});
    return  new SignedData({schema: cmsContentSimpl.content});
  }

  isVerificationFailed(verificationResult) {
    let failed = false;
    if (typeof verificationResult !== "undefined") {
      if (verificationResult === false) {
        failed = true;
      }
    }
    return failed;
  }

  isFromAddressCorrect(parser, signerEmail) {
    const fromNode = parser.node.headers.from[0].value[0];
    return fromNode.address === signerEmail;
  }

  nonceGenerator(length){
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for(let i = 0; i < length; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return stringToArrayBuffer(text);
  }
}

export default SmimeVerificationService;
