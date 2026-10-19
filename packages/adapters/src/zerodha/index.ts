// Zerodha adapter: tradebook (incl. the "Equity (external trades)" variant) and tax P&L; AGTS and P&L are
// recognised but not imported in v1 (PRD §6.3).
import type {
  AdapterInput,
  BrokerAdapter,
  Detection,
  FileProbe,
  ParseResult,
  ReportKind,
  SheetData,
} from '../contract.js';
import { cellText } from '../cells.js';
import { isTaxPnl, parseTaxPnl } from './tax-pnl.js';
import { parseTradebook, tradebookHeaderConfidence } from './tradebook.js';

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

function sheetTitles(sheets: readonly SheetData[]): string[] {
  return sheets.flatMap((sheet) =>
    sheet.rows.flatMap((row) => row.map(cellText).filter((text): text is string => text !== null)),
  );
}

function detect(probe: FileProbe): Detection | null {
  if (probe.type === 'text') {
    const confidence = tradebookHeaderConfidence(firstLine(probe.head));
    return confidence > 0 ? { kind: 'zerodha.tradebook', confidence } : null;
  }
  if (isTaxPnl(probe.sheets.map((sheet) => sheet.name))) return { kind: 'zerodha.tax_pnl', confidence: 1 };
  const titles = sheetTitles(probe.sheets);
  if (titles.some((title) => title.startsWith('Annual Global Transaction Statement')))
    return { kind: 'zerodha.agts', confidence: 1 };
  if (titles.some((title) => title.startsWith('P&L Statement for ')))
    return { kind: 'zerodha.pnl', confidence: 1 };
  return null;
}

function parse(input: AdapterInput, kind: ReportKind): ParseResult {
  if ((kind === 'zerodha.tradebook' || kind === 'zerodha.tradebook_external') && input.type === 'text') {
    return parseTradebook(input.text, kind === 'zerodha.tradebook' ? 'tradebook' : 'external');
  }
  if (kind === 'zerodha.tax_pnl' && input.type === 'sheets') return parseTaxPnl(input.sheets);
  throw new Error(`zerodha adapter cannot parse ${kind} from ${input.type} input`);
}

export const zerodhaAdapter: BrokerAdapter = {
  broker: 'zerodha',
  version: '1',
  reportKinds: ['zerodha.tradebook', 'zerodha.tradebook_external', 'zerodha.tax_pnl'],
  rejectedKinds: [
    {
      kind: 'zerodha.agts',
      message: 'The Annual Global Statement is not needed in v1. Import the Tradebook instead.',
    },
    {
      kind: 'zerodha.pnl',
      message: 'The P&L report is not needed in v1. Import the Tradebook (and Tax P&L for charges).',
    },
  ],
  detect,
  parse,
};
