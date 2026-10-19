// Worker thread shell for readSpreadsheet: all logic lives in spreadsheet-core.mjs (tested in-process).
import { parentPort, workerData } from 'node:worker_threads';
import { parseWorkbook } from './spreadsheet-core.mjs';

parentPort?.postMessage(parseWorkbook(workerData.bytes, workerData.limits));
