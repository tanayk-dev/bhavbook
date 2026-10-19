// Picks the adapter(s) that recognise a file. Pure: the caller builds the probe from the file.
import type { BrokerAdapter, BrokerId, FileProbe, ReportKind } from './contract.js';

export interface DetectionCandidate {
  readonly broker: BrokerId;
  readonly kind: ReportKind;
  readonly confidence: number;
  /** Set when the kind is recognised but not imported in v1: the message to show. */
  readonly rejected?: string;
}

/** Every adapter's opinion on the file, best first. Ambiguity (several candidates) is for the UI to resolve. */
export function detectReport(adapters: readonly BrokerAdapter[], probe: FileProbe): DetectionCandidate[] {
  return adapters
    .flatMap((adapter): DetectionCandidate[] => {
      const detection = adapter.detect(probe);
      if (detection === null || !(detection.confidence > 0 && detection.confidence <= 1)) return [];
      const rejected = adapter.rejectedKinds.find((entry) => entry.kind === detection.kind);
      const candidate = { broker: adapter.broker, kind: detection.kind, confidence: detection.confidence };
      if (rejected) return [{ ...candidate, rejected: rejected.message }];
      return adapter.reportKinds.includes(detection.kind) ? [candidate] : [];
    })
    .sort((a, b) => b.confidence - a.confidence);
}
