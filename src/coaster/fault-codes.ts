/** Stable native refusal identifiers, also carried unchanged by agent tools. */
export const faultCodes = {
  invalidArguments: 'invalid_arguments',
  authenticationRequired: 'authentication_required',
  authorityRequired: 'native_authority_required',
  unavailable: 'resource_unavailable',
  conflict: 'native_conflict',
  tooLarge: 'request_too_large',
  refused: 'native_refusal',
} as const;

export type FaultCode = typeof faultCodes[keyof typeof faultCodes];

/** HTTP keeps its existing statuses; the native fault owns its public code. */
export function faultCode(status: number): FaultCode {
  switch (status) {
    case 400: case 422: return faultCodes.invalidArguments;
    case 401: return faultCodes.authenticationRequired;
    case 403: return faultCodes.authorityRequired;
    case 404: return faultCodes.unavailable;
    case 409: return faultCodes.conflict;
    case 413: return faultCodes.tooLarge;
    default: return faultCodes.refused;
  }
}
