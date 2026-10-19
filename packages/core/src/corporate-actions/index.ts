// The public surface; the engine's internals (apply.ts) stay inside core.
export { previewCorporateAction, type CorporateActionPreview, type PreviewLot } from './preview.js';
export { suspectCorporateActions, type CorporateActionSuspicion } from './suspicion.js';
export type { CorporateAction, CorporateActionType, Fraction } from './types.js';
