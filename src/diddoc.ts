// literally https://github.com/notjuliet/pdsls/blob/456de9478606edf81f92977288143b5050c8bb93/src/utils/types.ts
interface DidDoc {
  "@context": string[];
  id: string;
  alsoKnownAs: string[];
  verificationMethod: DidVerificationMethod[];
  service: DidService[];
}

interface DidVerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}

interface DidService {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export type { DidDoc };
