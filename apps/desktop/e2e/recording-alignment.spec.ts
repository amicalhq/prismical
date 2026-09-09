import { test, expect, type Page } from '@playwright/test';
import { createId } from '@prismical/id';
import type { RecordingStateView, TransportRequest } from '@prismical/desktop-contracts';
import { launchPrismical, closePrismical, type PrismicalLaunch } from './helpers/launch';

const request = (page: Page, req: TransportRequest) =>
  page.evaluate(input => window.desktop.transport.request(input), req);

async function createNote(page: Page) {
  await page.evaluate(() => {
    window.location.hash = '#/home';
  });
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/notes\/nt_/);
  await expect(page.locator('.note-prose')).toHaveAttribute('contenteditable', 'true');
  return page.evaluate(() => window.location.hash.replace('#/notes/', ''));
}

function recordingView(noteId: string, recordingId = 'rec_alignment'): RecordingStateView {
  return {
    recordingId,
    noteId,
    status: 'recording',
    captureMode: 'mic',
    requestedCaptureMode: 'mic',
    micSource: 'system-default',
    elapsedMs: 5_000,
    elapsedAt: Date.now(),
    startedAt: Date.now() - 5_000,
    finalizingRecordingIds: [],
    completedRecordings: [],
    segments: [
      {
        id: 'tsg_alignment',
        recordingId,
        source: 'mic',
        speaker: 'you',
        text: 'Transcript from the recording owner.',
        startTimeMs: 0,
        endTimeMs: 5_000,
        segmentOrder: 0,
      },
    ],
  };
}

test.describe('recording dock alignment', () => {
  let launched: PrismicalLaunch;
  let page: Page;

  test.beforeEach(async () => {
    launched = await launchPrismical({ PRISMICAL_E2E_FAKE_AI: '1' }, { seedMode: 'local' });
    page = await launched.app.firstWindow();
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
  });
  test.afterEach(async () => {
    await closePrismical(launched);
  });

  test('keeps the owner dock across note navigation and returns on Stop', async () => {
    const owner = await createNote(page);
    const other = await createNote(page);
    await page.evaluate(id => {
      window.location.hash = `#/notes/${id}`;
    }, owner);
    await expect(page.locator('.note-prose')).toHaveAttribute('contenteditable', 'true');
    await page.evaluate(
      view => window.desktop.e2e!.recording({ kind: 'push', view }),
      recordingView(owner)
    );
    await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();

    await page.evaluate(id => {
      window.location.hash = `#/notes/${id}`;
    }, other);
    await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show transcription', exact: true }).click();
    await expect(
      page.getByText('Transcript from the recording owner.', { exact: true })
    ).toBeVisible();
    await expect(page.locator('.note-prose')).not.toContainText(
      'Transcript from the recording owner.'
    );
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/notes/${owner}`);
  });

  test('keeps paused and finishing workflows on their owner while Ask stays available', async () => {
    const owner = await createNote(page);
    const other = await createNote(page);
    const view = recordingView(owner);
    await page.evaluate(
      state => window.desktop.e2e!.recording({ kind: 'push', view: state }),
      view
    );
    await expect(page.getByRole('button', { name: 'Pause recording', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open note', exact: true })).toBeVisible();

    await page.evaluate(state => window.desktop.e2e!.recording({ kind: 'push', view: state }), {
      ...view,
      status: 'paused' as const,
      elapsedMs: 65_000,
      elapsedAt: Date.now(),
    });
    await expect(page.getByRole('status')).toContainText('Recording paused in another note');
    await expect(page.getByRole('button', { name: 'Resume recording', exact: true })).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Show transcription', exact: true })
    ).toContainText('1:05');
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await expect(page.getByLabel('Ask anything — / for skills, @ to tag notes')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show transcription', exact: true }).click();
    await expect(
      page.getByText('Transcript from the recording owner.', { exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume recording', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.evaluate(state => window.desktop.e2e!.recording({ kind: 'push', view: state }), {
      ...view,
      status: 'stopping' as const,
      elapsedMs: 65_000,
      elapsedAt: Date.now(),
      finalizingRecordingIds: [view.recordingId!],
    });
    await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await expect(page.getByLabel('Ask anything — / for skills, @ to tag notes')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show transcription', exact: true }).click();
    await expect(page.getByText('Finishing up…', { exact: true }).last()).toBeVisible();
    await expect(
      page.getByText('Transcript from the recording owner.', { exact: true })
    ).toBeVisible();
    await expect(page.locator('.note-prose')).not.toContainText(
      'Transcript from the recording owner.'
    );
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/notes/${other}`);
    await page.getByRole('button', { name: 'Open note', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/notes/${owner}`);
    await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toHaveCount(0);
  });

  test('scrolls the last note line above the dock in main and compact windows', async () => {
    const noteId = await createNote(page);
    const lines = Array.from({ length: 45 }, (_, index) => `Note line ${index + 1}.`);
    lines.push('Final line above the dock.');
    await page.locator('.note-prose').fill(lines.join('\n'));
    await expect(page.locator('.note-prose')).toContainText('Final line above the dock.');
    await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window =>
        window.webContents.getURL().includes('#/notes/')
      );
      main!.setSize(800, 600);
    });

    const verifyClearance = async (surface: Page) => {
      await expect
        .poll(() =>
          surface.evaluate(() => {
            const editor = document.querySelector<HTMLElement>('.note-prose')!;
            let scroller = editor.parentElement;
            while (scroller && getComputedStyle(scroller).overflowY !== 'auto')
              scroller = scroller.parentElement;
            if (!scroller) return false;
            scroller.scrollTop = scroller.scrollHeight;
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
              const offset = node.textContent!.indexOf('Final line above the dock.');
              if (offset < 0) continue;
              const range = document.createRange();
              range.setStart(node, offset);
              range.setEnd(node, offset + 'Final line above the dock.'.length);
              const line = range.getBoundingClientRect();
              const dock = [...document.querySelectorAll('[data-toast-obstacle]')]
                .map(element => element.getBoundingClientRect())
                .find(rect => rect.width > 0 && rect.height > 0);
              return Boolean(
                dock &&
                scroller.scrollTop > 0 &&
                line.top >= scroller.getBoundingClientRect().top &&
                line.bottom <= dock.top - 8
              );
            }
            return false;
          })
        )
        .toBe(true);
    };
    await verifyClearance(page);
    await page.screenshot({ path: test.info().outputPath('main-scroll-clearance.png') });
    await page.evaluate(id => window.desktop.float.open(id), noteId);
    await expect
      .poll(() => launched.app.windows().filter(window => window.url().includes('#/float')).length)
      .toBe(1);
    const floating = launched.app.windows().find(window => window.url().includes('#/float'))!;
    await expect(floating.locator('.note-prose')).toContainText('Final line above the dock.');
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find(window => window.webContents.getURL().includes('#/float'))!
        .setSize(440, 520);
    });
    await verifyClearance(floating);
    await floating.screenshot({ path: test.info().outputPath('float-scroll-clearance.png') });
  });

  test('returns the floating dock to its owner and exposes automatic-stop feedback', async () => {
    const owner = await createNote(page);
    const other = await createNote(page);
    await page.evaluate(id => window.desktop.float.open(id), owner);
    await expect
      .poll(() => launched.app.windows().filter(window => window.url().includes('#/float')).length)
      .toBe(1);
    const floating = launched.app.windows().find(window => window.url().includes('#/float'))!;
    await expect(floating.locator('.note-prose')).toHaveAttribute('contenteditable', 'true');
    await page.evaluate(
      view => window.desktop.e2e!.recording({ kind: 'push', view }),
      recordingView(owner)
    );
    await expect(
      floating.getByRole('button', { name: 'Stop recording', exact: true })
    ).toBeVisible();
    await page.evaluate(id => window.desktop.float.open(id), other);
    await expect.poll(() => floating.evaluate(() => window.location.hash)).toBe(`#/float/${other}`);
    await floating.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect.poll(() => floating.evaluate(() => window.location.hash)).toBe(`#/float/${owner}`);
    await expect(floating.getByRole('button', { name: 'Dock back into app' })).toBeVisible();
    await expect(floating.getByTestId('desktop-shell')).toHaveCount(0);

    // The injected capture has no native worker to publish its completion.
    // Finish it before starting the separate auto-stop session.
    await page.evaluate(view => window.desktop.e2e!.recording({ kind: 'push', view }), {
      ...recordingView(owner),
      status: 'idle' as const,
      completedRecordings: [{ recordingId: 'rec_alignment', noteId: owner, segments: 1 }],
    });
    await expect(
      floating.getByRole('button', { name: 'Start recording', exact: true })
    ).toBeEnabled();

    await page.evaluate(id => window.desktop.float.open(id), other);
    await expect.poll(() => floating.evaluate(() => window.location.hash)).toBe(`#/float/${other}`);
    await page.evaluate(view => window.desktop.e2e!.recording({ kind: 'push', view }), {
      ...recordingView(owner, 'rec_alignment_auto_stop'),
      status: 'paused' as const,
      autoStopRequested: true,
    });
    await expect(floating.locator('[data-sonner-toast]')).toContainText('Recording stopped');
    await expect(floating.locator('[data-sonner-toast]')).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        floating.evaluate(() => {
          const toast = document.querySelector('[data-sonner-toast]')!.getBoundingClientRect();
          return [...document.querySelectorAll('[data-toast-obstacle]')]
            .map(element => element.getBoundingClientRect())
            .filter(
              rect =>
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left < toast.right &&
                rect.right > toast.left
            )
            .every(rect => toast.bottom <= rect.top - 8);
        })
      )
      .toBe(true);
    await expect.poll(() => floating.evaluate(() => window.location.hash)).toBe(`#/float/${other}`);
    await floating.screenshot({ path: test.info().outputPath('float-recording.png') });
    await floating
      .locator('[data-sonner-toast]')
      .getByRole('button', { name: 'Go to note', exact: true })
      .click();
    await expect.poll(() => floating.evaluate(() => window.location.hash)).toBe(`#/float/${owner}`);
    await expect(floating.getByRole('button', { name: 'Dock back into app' })).toBeVisible();
  });

  for (const action of ['Keep', 'Undo'] as const) {
    test(`recovers completed local output after restart and remembers ${action}`, async () => {
      const otherId = await createNote(page);
      await page.locator('.note-prose').fill('Another note stays unchanged.');
      const noteId = await createNote(page);
      // The editor never receives this generation response: it has been left before
      // the completed result is created through the real local transport/backend.
      await page.evaluate(() => {
        window.location.hash = '#/home';
      });
      await expect(page.locator('.note-prose')).toHaveCount(0);
      const recordingId = createId('recording');
      expect(
        await request(page, {
          method: 'POST',
          path: '/apps/v1/me/recordings',
          body: {
            id: recordingId,
            noteId,
            title: 'Recovery recording',
            captureMode: 'mic',
            status: 'completed',
          },
        })
      ).toMatchObject({ ok: true, status: 201 });
      expect(
        await request(page, {
          method: 'POST',
          path: '/apps/v1/me/transcript-segments',
          body: {
            id: createId('transcriptSegment'),
            recordingId,
            source: 'mic',
            speaker: 'you',
            text: 'Prepare the launch plan for Friday.',
            startTimeMs: 0,
            endTimeMs: 5_000,
            isFinal: true,
          },
        })
      ).toMatchObject({ ok: true, status: 201 });
      const result = await request(page, {
        method: 'POST',
        path: '/apps/v1/me/skills/skl_enhance/run',
        body: { noteId, recordingId, recoverable: true },
      });
      expect(result).toMatchObject({
        ok: true,
        status: 200,
        bodyJson: {
          resultId: expect.any(String),
          rawMarkdown: expect.stringContaining('deterministic local test summary'),
        },
      });
      const profile = launched.userDataDir;
      await closePrismical(launched, { keepProfile: true });
      launched = await launchPrismical({
        PRISMICAL_E2E_USER_DATA_DIR: profile,
        PRISMICAL_E2E_FAKE_AI: '1',
      });
      page = await launched.app.firstWindow();
      await expect(page.getByTestId('desktop-shell')).toBeVisible();
      await page.evaluate(id => {
        window.location.hash = `#/notes/${id}`;
      }, noteId);
      await expect(page.getByRole('button', { name: 'Keep', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Show transcription', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Start recording', exact: true })
      ).toBeDisabled();
      await page.getByRole('button', { name: 'Hide transcription', exact: true }).click();
      await page.evaluate(id => {
        window.location.hash = `#/notes/${id}`;
      }, otherId);
      await expect(page.locator('.note-prose')).toHaveText('Another note stays unchanged.');
      await expect(page.getByRole('button', { name: 'Keep', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Ask AI', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Open note', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Show transcription', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Start recording', exact: true })
      ).toBeDisabled();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: action, exact: true }).click();
      await expect(page.getByRole('button', { name: 'Keep', exact: true })).toHaveCount(0);
      await expect(page.locator('.note-prose')).toHaveText('Another note stays unchanged.');
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/notes/${otherId}`);
      await expect(page.getByRole('button', { name: 'Ask AI', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Start recording', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Start recording', exact: true })
      ).toBeEnabled();
      await expect(
        page.getByText('Prepare the launch plan for Friday.', { exact: true })
      ).toHaveCount(0);
      await page.evaluate(id => {
        window.location.hash = `#/notes/${id}`;
      }, noteId);
      expect(
        await request(page, {
          method: 'GET',
          path: '/apps/v1/me/skill-runs/pending',
          query: { noteId },
        })
      ).toMatchObject({ ok: true, status: 200, bodyJson: { results: [] } });
      const expectedBody = action === 'Keep' ? /This is a deterministic local test summary\./ : '';
      await expect(page.locator('.note-prose')).toHaveText(expectedBody);
      await page.reload();
      await expect(page.locator('.note-prose')).toHaveAttribute('contenteditable', 'true');
      await expect(page.getByRole('button', { name: 'Keep', exact: true })).toHaveCount(0);
      await expect(page.locator('.note-prose')).toHaveText(expectedBody);
      const artifactCount = { Keep: 1, Undo: 0 }[action];
      const artifacts = await request(page, {
        method: 'GET',
        path: '/apps/v1/me/artifacts',
        query: { noteId },
      });
      expect(artifacts).toMatchObject({ ok: true, bodyJson: { results: expect.any(Array) } });
      expect((artifacts as { bodyJson: { results: unknown[] } }).bodyJson.results).toHaveLength(
        artifactCount
      );
    });
  }
});
