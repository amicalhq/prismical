import { parentPort, workerData } from 'node:worker_threads';
import * as Y from 'yjs';
import { deriveNoteContentFromYDoc } from '@prismical/note-derive';

// One bounded validation per worker. The main process only stores the receipt;
// the renderer applies it through the existing native note delivery log.
const { resultId, applicationUpdate } = workerData as {
  resultId: string;
  applicationUpdate: string;
};
const document = new Y.Doc();
let valid = false;
try {
  Y.applyUpdate(document, Buffer.from(applicationUpdate, 'base64'));
  if (document.getMap('appliedSkillResults').get(resultId) === true) {
    deriveNoteContentFromYDoc(document);
    valid = true;
  }
} catch {
  // Invalid encoding, a missing marker, and an unsupported schema all conflict.
} finally {
  document.destroy();
}
parentPort?.postMessage(valid);
