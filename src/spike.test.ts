import {
  FORMULA_BUTTON_ID,
  registerFormulaButton,
  runFormulaPipeline,
  type CommAPILike,
  type FileAPILike,
  type Logger,
  type NoteAPILike,
  type PluginManagerLike,
} from './spike';

const ok = <T>(result: T) => ({ success: true, result });
const fail = (code: number, message: string) => ({
  success: false,
  error: { code, message },
});

const makeLogger = (): Logger & {
  log: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
} => ({
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const stubRect = { left: 10, top: 20, right: 110, bottom: 70 };
const stubPageSize = { width: 1404, height: 1872 };
const stubNotePath = '/storage/emulated/0/Note/test.note';
const stubPageNum = 0;

const makeComm = (overrides: Partial<CommAPILike> = {}): CommAPILike => ({
  getLassoElements: jest.fn(async () => ok([{ uuid: 's1' }])),
  getLassoElementTypeCounts: jest.fn(async () => ok({ trailNum: 1 })),
  getLassoRect: jest.fn(async () => ok(stubRect)),
  getCurrentFilePath: jest.fn(async () => ok(stubNotePath)),
  getCurrentPageNum: jest.fn(async () => ok(stubPageNum)),
  recognizeElements: jest.fn(async () => ok('2x + 3 = 7')),
  deleteLassoElements: jest.fn(async () => ok(true)),
  setLassoBoxState: jest.fn(async () => ok(true)),
  ...overrides,
});

const makeNote = (overrides: Partial<NoteAPILike> = {}): NoteAPILike => ({
  insertText: jest.fn(async () => ok(true)),
  getLassoText: jest.fn(async () => ok([])),
  ...overrides,
});

const makeFile = (overrides: Partial<FileAPILike> = {}): FileAPILike => ({
  getPageSize: jest.fn(async () => ok(stubPageSize)),
  ...overrides,
});

describe('runFormulaPipeline', () => {
  test('happy path: delete → recognize → insert → setLassoBoxState(2) in order', async () => {
    const logger = makeLogger();
    const comm = makeComm();
    const note = makeNote();
    const order: string[] = [];
    (comm.deleteLassoElements as jest.Mock).mockImplementation(async () => {
      order.push('delete');
      return ok(true);
    });
    (comm.recognizeElements as jest.Mock).mockImplementation(async () => {
      order.push('recognize');
      return ok('2x + 3 = 7');
    });
    (note.insertText as jest.Mock).mockImplementation(async () => {
      order.push('insert');
      return ok(true);
    });
    (comm.setLassoBoxState as jest.Mock).mockImplementation(async () => {
      order.push('lasso-box');
      return ok(true);
    });

    const result = await runFormulaPipeline(comm, note, makeFile(), logger);

    expect(result).toEqual({
      outcome: 'replaced',
      recognized: '2x + 3 = 7',
    });
    expect(order).toEqual(['delete', 'recognize', 'insert', 'lasso-box']);
    expect(comm.setLassoBoxState).toHaveBeenCalledWith(2);
    expect(note.insertText).toHaveBeenCalledWith(
      expect.objectContaining({
        textContentFull: '2x + 3 = 7',
        textFrameWidthType: 1,
      }),
    );
    // Rect origin is preserved regardless of any safety widening.
    const insertArg = (note.insertText as jest.Mock).mock.calls[0][0];
    expect(insertArg.textRect.left).toBe(stubRect.left);
    expect(insertArg.textRect.top).toBe(stubRect.top);
    expect(insertArg.textRect.bottom).toBe(stubRect.bottom);
    expect(comm.recognizeElements).toHaveBeenCalledWith(
      expect.any(Array),
      stubPageSize,
    );
  });

  test('warns but still resolves replaced when setLassoBoxState fails on success path', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      setLassoBoxState: jest.fn(async () => fail(0, 'no lasso')),
    });
    const result = await runFormulaPipeline(comm, makeNote(), makeFile(), logger);
    expect(result.outcome).toBe('replaced');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('setLassoBoxState(2) returned success=false'),
    );
  });

  test('warns with default message when setLassoBoxState returns success=false without an error field', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      setLassoBoxState: jest.fn(async () => ({ success: false })),
    });
    const result = await runFormulaPipeline(comm, makeNote(), makeFile(), logger);
    expect(result.outcome).toBe('replaced');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no error message'),
    );
  });

  test('does not call setLassoBoxState on a no-strokes early-out', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      getLassoElementTypeCounts: jest.fn(async () => ok({ trailNum: 0 })),
    });
    await runFormulaPipeline(comm, makeNote(), makeFile(), logger);
    expect(comm.setLassoBoxState).not.toHaveBeenCalled();
  });

  test('does not call setLassoBoxState on a failure path', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      recognizeElements: jest.fn(async () => fail(7, 'ocr-down')),
    });
    await runFormulaPipeline(comm, makeNote(), makeFile(), logger);
    expect(comm.setLassoBoxState).not.toHaveBeenCalled();
  });

  test('short-circuits when lasso has no strokes', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      getLassoElementTypeCounts: jest.fn(async () => ok({ trailNum: 0 })),
    });
    const note = makeNote();
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('no-strokes');
    expect(comm.getLassoElements).not.toHaveBeenCalled();
    expect(comm.recognizeElements).not.toHaveBeenCalled();
    expect(note.insertText).not.toHaveBeenCalled();
  });

  test('reports recognizer-empty without inserting (delete already ran)', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      recognizeElements: jest.fn(async () => ok('')),
    });
    const note = makeNote();
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('recognizer-empty');
    expect(note.insertText).not.toHaveBeenCalled();
    expect(comm.deleteLassoElements).toHaveBeenCalled();
  });

  test('reports recognizer-failed without inserting (delete already ran)', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      recognizeElements: jest.fn(async () => fail(7, 'ocr-down')),
    });
    const note = makeNote();
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('recognizer-failed');
    expect(note.insertText).not.toHaveBeenCalled();
    expect(comm.deleteLassoElements).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ocr-down'),
    );
  });

  test('does not recognize or insert when delete fails (delete-first ordering)', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      deleteLassoElements: jest.fn(async () => fail(99, 'denied')),
    });
    const note = makeNote();
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('delete-failed');
    expect(comm.recognizeElements).not.toHaveBeenCalled();
    expect(note.insertText).not.toHaveBeenCalled();
  });

  test('reports insert-failed (data-loss) when insertText fails after a successful delete', async () => {
    const logger = makeLogger();
    const comm = makeComm();
    const note = makeNote({
      insertText: jest.fn(async () => fail(3001, 'empty content')),
    });
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('insert-failed');
    expect(comm.deleteLassoElements).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('user must undo to recover'),
    );
  });

  test('logs and swallows getLassoText probe failure without breaking the pipeline', async () => {
    const logger = makeLogger();
    const comm = makeComm();
    const note = makeNote({
      getLassoText: jest.fn(async () => fail(2, 'no lasso text')),
    });
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('replaced');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[formula:lasso-text]'),
    );
  });

  test('reports trailNum + element count + rect dimensions in logs', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      getLassoRect: jest.fn(async () =>
        ok({ left: 0, top: 0, right: 200, bottom: 100 }),
      ),
    });
    const note = makeNote();
    await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('trailNum=1'),
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('200x100'),
    );
  });

  test('treats result-less success as a thrown error', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      getLassoElementTypeCounts: jest.fn(async () => ({ success: true })),
    });
    const note = makeNote();
    await expect(runFormulaPipeline(comm, note, makeFile(), logger)).rejects.toThrow(
      'returned no result',
    );
  });

  test('treats a null SDK response as a thrown error with default code/message', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      getLassoElementTypeCounts: jest.fn(async () => null as never),
    });
    const note = makeNote();
    await expect(runFormulaPipeline(comm, note, makeFile(), logger)).rejects.toThrow(
      'failed (code -1): no error message',
    );
  });

  test('treats a null recognize response as a recognizer-failed outcome', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      recognizeElements: jest.fn(async () => null as never),
    });
    const note = makeNote();
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('recognizer-failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('no error message'),
    );
  });

  test('treats a null insert response as an insert-failed outcome (delete already ran)', async () => {
    const logger = makeLogger();
    const comm = makeComm();
    const note = makeNote({
      insertText: jest.fn(async () => null as never),
    });
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('insert-failed');
    // With delete-first ordering, the original strokes are already gone
    // by the time insert fails — recovery is via Supernote's undo.
    expect(comm.deleteLassoElements).toHaveBeenCalled();
  });

  test('treats a null delete response as a delete-failed outcome', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      deleteLassoElements: jest.fn(async () => null as never),
    });
    const note = makeNote();
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('delete-failed');
  });

  test('handles fallback recognizer success without a result string', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      recognizeElements: jest.fn(async () => ({ success: true })),
    });
    const note = makeNote();
    const result = await runFormulaPipeline(comm, note, makeFile(), logger);
    expect(result.outcome).toBe('recognizer-empty');
    expect(note.insertText).not.toHaveBeenCalled();
  });

  test('clamps fontSize to a minimum floor for tiny rects', async () => {
    const logger = makeLogger();
    const comm = makeComm({
      getLassoRect: jest.fn(async () =>
        ok({ left: 0, top: 0, right: 10, bottom: 5 }),
      ),
    });
    const note = makeNote();
    await runFormulaPipeline(comm, note, makeFile(), logger);
    const arg = (note.insertText as jest.Mock).mock.calls[0][0];
    expect(arg.fontSize).toBe(12);
  });

  test('uses height-based fontSize when width is generous', async () => {
    // 1000-wide rect, 100-tall, 6-char string.
    // fromHeight = 100*0.6 = 60; fromWidth = 1000/(6*1.0) ≈ 166. Min = 60.
    const logger = makeLogger();
    const comm = makeComm({
      getLassoRect: jest.fn(async () =>
        ok({ left: 0, top: 0, right: 1000, bottom: 100 }),
      ),
    });
    const note = makeNote();
    await runFormulaPipeline(comm, note, makeFile(), logger);
    const arg = (note.insertText as jest.Mock).mock.calls[0][0];
    expect(arg.fontSize).toBeCloseTo(60);
  });

  test('shrinks fontSize when the rect width would otherwise wrap the text', async () => {
    // 200-wide rect, 100-tall, 10-char string.
    // fromHeight = 60; fromWidth = 200/(10*1.0) = 20. Min = 20.
    const logger = makeLogger();
    const comm = makeComm({
      getLassoRect: jest.fn(async () =>
        ok({ left: 0, top: 0, right: 200, bottom: 100 }),
      ),
      recognizeElements: jest.fn(async () => ok('1234567890')),
    });
    const note = makeNote();
    await runFormulaPipeline(comm, note, makeFile(), logger);
    const arg = (note.insertText as jest.Mock).mock.calls[0][0];
    expect(arg.fontSize).toBeLessThan(60);
    expect(arg.fontSize).toBeGreaterThanOrEqual(12);
  });

  test('widens the textRect by the safety margin when at the edge of fitting', async () => {
    // 446-wide rect, 180-tall, 6-char string ("2×+3=7" reproduction).
    // fromHeight = 108; fromWidth = 446/6 ≈ 74. fontSize = 74.
    // requiredWidth = 6 * 74 * 1.0 * 1.15 ≈ 511 → rect widened.
    const logger = makeLogger();
    const comm = makeComm({
      getLassoRect: jest.fn(async () =>
        ok({ left: 462, top: 329, right: 908, bottom: 509 }),
      ),
      recognizeElements: jest.fn(async () => ok('2×+3=7')),
    });
    const note = makeNote();
    await runFormulaPipeline(comm, note, makeFile(), logger);
    const arg = (note.insertText as jest.Mock).mock.calls[0][0];
    // Width should grow past the original 446 to absorb renderer slop.
    expect(arg.textRect.right - arg.textRect.left).toBeGreaterThan(446);
    // Origin is preserved.
    expect(arg.textRect.left).toBe(462);
    expect(arg.textRect.top).toBe(329);
  });

  test('widens the textRect when the rect cannot contain the text at MIN_FONT_SIZE', async () => {
    // 30-wide rect, 5-tall, 20-char string. Both clamps push fontSize to
    // MIN_FONT_SIZE=12; required = 20*12*1.0*1.15 = 276 px > 30 → rect grows.
    const logger = makeLogger();
    const comm = makeComm({
      getLassoRect: jest.fn(async () =>
        ok({ left: 100, top: 200, right: 130, bottom: 205 }),
      ),
      recognizeElements: jest.fn(async () => ok('abcdefghijklmnopqrst')),
    });
    const note = makeNote();
    await runFormulaPipeline(comm, note, makeFile(), logger);
    const arg = (note.insertText as jest.Mock).mock.calls[0][0];
    expect(arg.fontSize).toBe(12);
    expect(arg.textRect.right - arg.textRect.left).toBeGreaterThanOrEqual(276);
    expect(arg.textRect.left).toBe(100);
    expect(arg.textRect.top).toBe(200);
  });

  test('leaves textRect untouched when fontSize plus margin still fits the original rect', async () => {
    // 5000-wide rect, 100-tall, 6-char string. Even with margin the
    // required width is well under 5000, so no widening happens.
    const logger = makeLogger();
    const comm = makeComm({
      getLassoRect: jest.fn(async () =>
        ok({ left: 0, top: 0, right: 5000, bottom: 100 }),
      ),
    });
    const note = makeNote();
    await runFormulaPipeline(comm, note, makeFile(), logger);
    const arg = (note.insertText as jest.Mock).mock.calls[0][0];
    expect(arg.textRect).toEqual({ left: 0, top: 0, right: 5000, bottom: 100 });
  });
});

describe('registerFormulaButton', () => {
  const makeManager = (
    overrides: Partial<PluginManagerLike> = {},
  ): PluginManagerLike => ({
    registerButton: jest.fn(async () => true),
    registerButtonListener: jest.fn(() => ({ id: 1 })),
    getPluginDirPath: jest.fn(async () =>
      '/data/user/0/com.ratta.supernote.pluginhost/files/plugins/fp83qkmw2nv7zr6c',
    ),
    closePluginView: jest.fn(async () => true),
    ...overrides,
  });

  test('registers exactly one Formula button with editDataTypes:[0], a file:// icon URI, and no isHideToolbar', async () => {
    const pluginManager = makeManager();
    await registerFormulaButton({
      pluginManager,
      commAPI: makeComm(),
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger: makeLogger(),
    });
    expect(pluginManager.registerButton).toHaveBeenCalledTimes(1);
    const [type, appTypes, button] = (pluginManager.registerButton as jest.Mock).mock.calls[0];
    expect(type).toBe(2);
    expect(appTypes).toEqual(['NOTE']);
    expect(button).toEqual({
      id: FORMULA_BUTTON_ID,
      name: 'Formula',
      icon: 'file:///data/user/0/com.ratta.supernote.pluginhost/files/plugins/fp83qkmw2nv7zr6c/icon.png',
      enable: true,
      editDataTypes: [0],
    });
    // isHideToolbar must NOT be set — it appears to interrupt the gesture
    // lifecycle and hang the device on the tested firmware.
    expect(button).not.toHaveProperty('isHideToolbar');
    expect(pluginManager.registerButtonListener).toHaveBeenCalledTimes(1);
  });

  test('registers without an icon when getPluginDirPath returns null', async () => {
    const pluginManager = makeManager({
      getPluginDirPath: jest.fn(async () => null),
    });
    const logger = makeLogger();
    await registerFormulaButton({
      pluginManager,
      commAPI: makeComm(),
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger,
    });
    const button = (pluginManager.registerButton as jest.Mock).mock.calls[0][2];
    expect(button.icon).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no plugin dir available'),
    );
  });

  test('falls back to no icon if getPluginDirPath throws', async () => {
    const pluginManager = makeManager({
      getPluginDirPath: jest.fn(async () => {
        throw new Error('dir-down');
      }),
    });
    const logger = makeLogger();
    await registerFormulaButton({
      pluginManager,
      commAPI: makeComm(),
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger,
    });
    const button = (pluginManager.registerButton as jest.Mock).mock.calls[0][2];
    expect(button.icon).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('getPluginDirPath threw'),
    );
  });

  test('listener runs the pipeline, dismisses the lasso on success, and closes the plugin view', async () => {
    const pluginManager = makeManager();
    const comm = makeComm();
    const note = makeNote();
    await registerFormulaButton({
      pluginManager,
      commAPI: comm,
      noteAPI: note,
      fileAPI: makeFile(),
      logger: makeLogger(),
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(comm.recognizeElements).toHaveBeenCalledTimes(1);
    expect(note.insertText).toHaveBeenCalledTimes(1);
    expect(comm.setLassoBoxState).toHaveBeenCalledWith(2);
    expect(pluginManager.closePluginView).toHaveBeenCalledTimes(1);
  });

  test('always closes the plugin view, even when the pipeline fails', async () => {
    const pluginManager = makeManager();
    const comm = makeComm({
      recognizeElements: jest.fn(async () => fail(7, 'ocr-down')),
    });
    await registerFormulaButton({
      pluginManager,
      commAPI: comm,
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger: makeLogger(),
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(pluginManager.closePluginView).toHaveBeenCalledTimes(1);
  });

  test('warns if closePluginView throws — never blocks', async () => {
    const logger = makeLogger();
    const pluginManager = makeManager({
      closePluginView: jest.fn(async () => {
        throw new Error('close-down');
      }),
    });
    await registerFormulaButton({
      pluginManager,
      commAPI: makeComm(),
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger,
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('closePluginView threw'),
    );
  });

  test('warns if closePluginView returns falsy', async () => {
    const logger = makeLogger();
    const pluginManager = makeManager({
      closePluginView: jest.fn(async () => false),
    });
    await registerFormulaButton({
      pluginManager,
      commAPI: makeComm(),
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger,
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('closePluginView returned falsy'),
    );
  });

  test('does NOT call setLassoBoxState when the pipeline fails (host auto-clears on error)', async () => {
    // Old behavior was to always call setLassoBoxState in a finally,
    // even on failure paths. That ran after the host had already
    // auto-cleared the lasso, returned `success=false`, and corrupted
    // the gesture chain. New behavior: only release the lasso inline
    // on the success path.
    const pluginManager = makeManager();
    const comm = makeComm({
      recognizeElements: jest.fn(async () => fail(7, 'ocr-down')),
    });
    await registerFormulaButton({
      pluginManager,
      commAPI: comm,
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger: makeLogger(),
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(comm.setLassoBoxState).not.toHaveBeenCalled();
  });

  test('ignores re-entry while the pipeline is still running', async () => {
    const pluginManager = makeManager();
    const logger = makeLogger();
    let resolveInsert: (() => void) | null = null;
    const insertGate = new Promise<void>((r) => {
      resolveInsert = r;
    });
    const comm = makeComm();
    const note = makeNote({
      insertText: jest.fn(async () => {
        await insertGate;
        return ok(true);
      }),
    });
    await registerFormulaButton({
      pluginManager,
      commAPI: comm,
      noteAPI: note,
      fileAPI: makeFile(),
      logger,
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];

    // First press is in flight; second press should be rejected.
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('already running'),
    );
    expect(comm.deleteLassoElements).toHaveBeenCalledTimes(1);

    // Release the first press; a third press afterwards should be accepted.
    resolveInsert!();
    await new Promise((r) => setImmediate(r));
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(comm.deleteLassoElements).toHaveBeenCalledTimes(2);
  });

  test('still closes the plugin view on the reentrancy-rejection path', async () => {
    // The host adds an overlay window when the user taps Formula, even
    // if our reentrancy guard rejects the run. We must release it.
    const pluginManager = makeManager();
    let resolveInsert: (() => void) | null = null;
    const insertGate = new Promise<void>((r) => {
      resolveInsert = r;
    });
    const note = makeNote({
      insertText: jest.fn(async () => {
        await insertGate;
        return ok(true);
      }),
    });
    await registerFormulaButton({
      pluginManager,
      commAPI: makeComm(),
      noteAPI: note,
      fileAPI: makeFile(),
      logger: makeLogger(),
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];

    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));

    // Two presses ⇒ closePluginView must have been called twice (once
    // for the rejected re-entry, plus the eventual cleanup of the
    // accepted run).
    expect(pluginManager.closePluginView).toHaveBeenCalledTimes(1);

    resolveInsert!();
    await new Promise((r) => setImmediate(r));
    expect(pluginManager.closePluginView).toHaveBeenCalledTimes(2);
  });

  test('clears the reentrancy flag synchronously so a follow-up press after JS-context teardown is accepted', async () => {
    // Simulates the real-world bug: closePluginView suspends/destroys
    // the JS context. If `isProcessing = false` ran *after* the await,
    // it would never execute. Here we make closePluginView never resolve
    // (modelling a context-teardown that prevents resumption) and verify
    // the next press is still accepted.
    const pluginManager = makeManager({
      closePluginView: jest.fn(
        () =>
          new Promise<boolean>(() => {
            /* never resolves */
          }),
      ),
    });
    const comm = makeComm();
    await registerFormulaButton({
      pluginManager,
      commAPI: comm,
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger: makeLogger(),
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];

    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    // First pipeline ran to completion (delete + recognize + insert)
    // before closePluginView blocked.
    expect(comm.deleteLassoElements).toHaveBeenCalledTimes(1);

    // Second press: even though the first closePluginView never resolved,
    // the flag was cleared synchronously, so this must be accepted.
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(comm.deleteLassoElements).toHaveBeenCalledTimes(2);
  });

  test('listener ignores unrecognized button ids', async () => {
    const pluginManager = makeManager();
    const comm = makeComm();
    const note = makeNote();
    const logger = makeLogger();
    await registerFormulaButton({
      pluginManager,
      commAPI: comm,
      noteAPI: note,
      fileAPI: makeFile(),
      logger,
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];
    listener.onButtonPress({ id: 999 });
    await new Promise((r) => setImmediate(r));
    expect(comm.recognizeElements).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ignoring unknown button id=999'),
    );
  });

  test('pipeline crash is caught and logged via onPress', async () => {
    const exploding: Logger = {
      log: jest.fn((..._args: unknown[]) => {
        throw new Error('boom');
      }),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const pluginManager = makeManager();
    await registerFormulaButton({
      pluginManager,
      commAPI: makeComm(),
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger: exploding,
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(exploding.error).toHaveBeenCalledWith(
      expect.stringContaining('pipeline crashed'),
    );
  });

  test('listener-level catch fires when onPress own error handler also throws', async () => {
    const errorCalls: string[] = [];
    let errorThrows = true;
    const logger: Logger = {
      log: jest.fn((..._args: unknown[]) => {
        throw new Error('boom');
      }),
      warn: jest.fn(),
      error: jest.fn((msg: unknown) => {
        errorCalls.push(String(msg));
        if (errorThrows) {
          errorThrows = false;
          throw new Error('logger-error-down');
        }
      }),
    };
    const pluginManager = makeManager();
    await registerFormulaButton({
      pluginManager,
      commAPI: makeComm(),
      noteAPI: makeNote(),
      fileAPI: makeFile(),
      logger,
    });
    const listener = (pluginManager.registerButtonListener as jest.Mock).mock.calls[0][0];
    listener.onButtonPress({ id: FORMULA_BUTTON_ID });
    await new Promise((r) => setImmediate(r));
    expect(errorCalls.some((m) => m.includes('dispatch crashed'))).toBe(true);
  });
});
