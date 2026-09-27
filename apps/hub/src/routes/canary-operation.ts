// The reviewed plan digest authorizes application, but is not part of the
// strict release-canary identity used to resolve the bound operation.
export const canaryOperationIdentity = (request: {
  releaseId: string;
  recordDigest: string;
  stationId: string;
  operationId: string;
  planDigest: string;
}) => ({
  releaseId: request.releaseId,
  recordDigest: request.recordDigest,
  stationId: request.stationId,
  operationId: request.operationId,
});
