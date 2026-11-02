/**
 * The public entry point of services/matrix: the names other modules import, and nothing else.
 * Every import from outside this folder goes through here; see docs/contributor/code-quality.md.
 */
export {
  decryptAttachment,
  encryptAttachment,
  imageNote,
  imageSource,
  isRefusal,
  loadImage,
  parseMxc,
  promptBlocks,
} from "./attachments";
export type { EncryptedFile, EncryptedFileInfo, PromptImage } from "./attachments";
export {
  UnknownStationError,
  mintCredentialAuthorization,
  redeemCredentialAuthorization,
} from "./credential";
export { IDENTITY_UNAVAILABLE_TEXT, resolveMatrixId } from "./identity";
export {
  BRIDGE_ONLY_REFUSAL,
  bridgeLocalpart,
  bridgeUserId,
  isBridgeOnly,
  isBridgeUser,
  localpartFor,
  roomAliasFor,
  stationSpeaker,
} from "./names";
export { matrixIdForPrincipal } from "./principal-id";
