const constants = {
  smimeSpecification: {
    signatureNodeContentTypeValues: ['application/x-pkcs7-signature', 'application/pkcs7-signature'],
    rootNodeContentTypeValue: 'multipart/signed',
    rootNodeContentTypeProtocol: 'application/pkcs7-signature',
    rootNodeContentTypeMessageIntegrityCheckAlgorithms: ['md5', 'sha-1', 'sha-224', 'sha-256', 'sha-384', 'sha-512', 'unknown'],
  },
  smimeVerificationResultCodes: {
    VERIFICATION_OK: 'VERIFICATION_OK',
    CANNOT_VERIFY: 'CANNOT_VERIFY',
    FRAUD_WARNING: 'FRAUD_WARNING',
  },
  db: {
    dbName: 'RocketSMIMEBrowserExtensionDatabase',
    dbVersion: 1,
    stores: {
      results: 'results'
    }
  },
  inboxSDK: {
    API_VERSION: 1,
    API_KEY: 'sdk_RocketSMIME_4eac33aa65'
  },
};

export default constants;
