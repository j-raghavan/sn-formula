/**
 * Phase-1 spike harness for sn-formula.
 *
 * Registers a single "Formula" lasso-toolbar button. On tap, runs the
 * end-to-end pipeline from sn-formula-requirement.md §3 with phase-by-
 * phase logging so the kill-the-project spikes (1.2 lasso reads, 1.3
 * recognize, 1.4 replace) all surface from one user action. The §4.2
 * footnote `getLassoText` shortcut is exercised opportunistically as a
 * side probe.
 *
 * §6 hard rule is enforced: `deleteLassoElements()` is only called after
 * `insertText()` resolves successfully.
 */

type APIResponse<T> = {
  success: boolean;
  result?: T;
  error?: { code: number; message: string };
};

type Rect = { left: number; top: number; right: number; bottom: number };

type ButtonEvent = { id: number };

type ButtonListener = { onButtonPress: (event: ButtonEvent) => void };

type PluginButton = {
  id: number;
  name: string;
  icon: string;
  enable: boolean;
  /**
   * Lasso data types this button applies to. Required for type=2 (lasso)
   * buttons — without it the native menu treats the button as matching
   * nothing and never renders it in the lasso `...` toolbar.
   * 0=stroke, 1=title, 2=image, 3=text, 4=link, 5=geometric shape.
   * See `sn-plugin-lib/src/bean/PluginButton.ts`.
   */
  editDataTypes: number[];
};

export type PluginManagerLike = {
  registerButton: (
    type: number,
    appTypes: string[],
    button: PluginButton,
  ) => Promise<boolean>;
  registerButtonListener: (listener: ButtonListener) => { id: number };
  /**
   * Returns the plugin's data dir on the device, e.g.
   * `/data/user/0/com.ratta.supernote.pluginhost/files/plugins/<pluginID>`.
   * Used to build a `file://` URI for the lasso button icon.
   */
  getPluginDirPath: () => Promise<string | null | undefined>;
  /**
   * Removes the plugin host's display window. **Required** at the end of
   * every pipeline run — when the plugin is invoked, the host calls
   * `WindowManager.addWindow win:Window{... com.ratta.supernote.pluginhost}`
   * (logcat 04-26 16:59:58.001) which floats a full-screen window with
   * its own input channel on top of the note. Without this call the
   * window stays, captures every subsequent pen tap at the OS layer
   * (before RN sees them), and the device appears hung.
   */
  closePluginView: () => Promise<boolean>;
};

type Size = { width: number; height: number };

export type CommAPILike = {
  getLassoElements: () => Promise<APIResponse<unknown[]>>;
  getLassoElementTypeCounts: () => Promise<APIResponse<{ trailNum: number }>>;
  getLassoRect: () => Promise<APIResponse<Rect>>;
  getCurrentFilePath: () => Promise<APIResponse<string>>;
  getCurrentPageNum: () => Promise<APIResponse<number>>;
  recognizeElements: (
    elements: unknown[],
    size: Size,
  ) => Promise<APIResponse<string>>;
  deleteLassoElements: () => Promise<APIResponse<boolean>>;
  /**
   * `state=2` removes the lasso box completely. Required to dismiss the
   * lasso `...` overflow menu and exit lasso mode after the plugin acts;
   * without it the menu stays on screen and the device appears stuck.
   */
  setLassoBoxState: (state: number) => Promise<APIResponse<boolean>>;
};

export type FileAPILike = {
  getPageSize: (notePath: string, page: number) => Promise<APIResponse<Size>>;
};

export type NoteAPILike = {
  insertText: (textBox: {
    textContentFull: string;
    textRect: Rect;
    fontSize: number;
    textAlign: number;
    textBold: number;
    textItalics: number;
    /**
     * 0 = fixed-width box (text outside `textRect` is clipped),
     * 1 = auto-width box (the box grows to fit content). We use 1 so a
     * recognized string longer than the lasso rect is not truncated —
     * see logcat 04-26 16:10:03 (recognized "2×+3=7" but only "2×+3=" rendered).
     */
    textFrameWidthType: number;
  }) => Promise<APIResponse<boolean>>;
  getLassoText: () => Promise<APIResponse<unknown[]>>;
};

export type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export type PipelineOutcome =
  | 'no-strokes'
  | 'recognizer-empty'
  | 'recognizer-failed'
  | 'insert-failed'
  | 'delete-failed'
  | 'replaced';

export type PipelineResult = {
  outcome: PipelineOutcome;
  recognized?: string;
};

export const FORMULA_BUTTON_ID = 1;
const LASSO_BUTTON_TYPE = 2;
const STROKE_DATA_TYPE = 0;
const APP_TYPES = ['NOTE'];
const MIN_FONT_SIZE = 12;
// Height ratio used as one of two clamps when deriving fontSize. The other
// clamp is width-driven (see deriveFontSize): a shorter rect or longer
// recognized string forces a smaller font so the text fits horizontally.
const FONT_SIZE_RATIO = 0.6;
// Average character width as a fraction of fontSize. Sans fonts run
// ~0.5-0.6 in theory, but on-device the renderer wraps `"2×+3=7"` (6
// chars) inside a 446px rect at fontSize=106 — the typeset `7` ends up
// on a second line below the `=` (logcat 04-26 16:59:58 + screenshot).
// Treating each char as the full fontSize (1.0) is the most conservative
// estimate that still produces a sensibly-sized fontSize for typical
// formula lengths. We further extend the rect by `WIDTH_SAFETY_MARGIN`
// in `widenRectForText` so the renderer never sits on the edge.
const CHAR_WIDTH_FACTOR = 1.0;
const WIDTH_SAFETY_MARGIN = 1.15;

const rectWidth = (r: Rect): number => r.right - r.left;
const rectHeight = (r: Rect): number => r.bottom - r.top;

const expectSuccess = <T>(
  res: APIResponse<T> | null | undefined,
  context: string,
): T => {
  if (!res || !res.success) {
    const msg = res?.error?.message ?? 'no error message';
    const code = res?.error?.code ?? -1;
    throw new Error(`${context} failed (code ${code}): ${msg}`);
  }
  if (res.result === undefined) {
    throw new Error(`${context} returned no result`);
  }
  return res.result;
};

// Pipeline guarantees textLength > 0: empty recognizer results return the
// `recognizer-empty` outcome before this is called.
const deriveFontSize = (rect: Rect, textLength: number): number => {
  const fromHeight = rectHeight(rect) * FONT_SIZE_RATIO;
  // Width-bounded fontSize so `textLength * fontSize * CHAR_WIDTH_FACTOR`
  // fits in the rect width. `textFrameWidthType:1` did not auto-grow the
  // text box on the tested firmware, so we have to clamp here.
  const fromWidth = rectWidth(rect) / (textLength * CHAR_WIDTH_FACTOR);
  return Math.max(Math.min(fromHeight, fromWidth), MIN_FONT_SIZE);
};

/**
 * Widen the rect right edge to `textLength * fontSize * CHAR_WIDTH_FACTOR
 * * WIDTH_SAFETY_MARGIN`. Always grows when the rect is right at the
 * edge of fitting — the on-device renderer wraps text that fits "by the
 * math" but not in practice (logcat 04-26 16:59:58 + screenshot showing
 * the wrapped `7` artifact below the `=`).
 */
const widenRectForText = (
  rect: Rect,
  fontSize: number,
  textLength: number,
): Rect => {
  const requiredWidth = Math.ceil(
    textLength * fontSize * CHAR_WIDTH_FACTOR * WIDTH_SAFETY_MARGIN,
  );
  if (requiredWidth <= rectWidth(rect)) {
    return rect;
  }
  return { ...rect, right: rect.left + requiredWidth };
};

/**
 * Side probe: log how many already-typeset TextBoxes are under the lasso.
 * Never throws — failure is logged and swallowed so it cannot break the
 * primary pipeline.
 */
const probeLassoText = async (
  note: NoteAPILike,
  logger: Logger,
): Promise<void> => {
  try {
    const boxes = expectSuccess(await note.getLassoText(), 'getLassoText');
    logger.log(`[formula:lasso-text] count=${boxes.length}`);
  } catch (e) {
    logger.warn(`[formula:lasso-text] ${(e as Error).message}`);
  }
};

export const runFormulaPipeline = async (
  comm: CommAPILike,
  note: NoteAPILike,
  file: FileAPILike,
  logger: Logger,
): Promise<PipelineResult> => {
  // Side-probe the typeset-text shortcut alongside the main flow.
  await probeLassoText(note, logger);

  const counts = expectSuccess(
    await comm.getLassoElementTypeCounts(),
    'getLassoElementTypeCounts',
  );
  logger.log(`[formula:counts] trailNum=${counts.trailNum}`);
  if (counts.trailNum === 0) {
    logger.warn('[formula] no strokes in lasso — nothing to recognize');
    return { outcome: 'no-strokes' };
  }

  const elements = expectSuccess(
    await comm.getLassoElements(),
    'getLassoElements',
  );
  logger.log(`[formula:elements] length=${elements.length}`);

  const rect = expectSuccess(await comm.getLassoRect(), 'getLassoRect');
  logger.log(
    `[formula:rect] ${rect.left},${rect.top} ${rectWidth(rect)}x${rectHeight(rect)}`,
  );

  // Pre-fetch page info while the lasso is still active. recognizeElements
  // is called *after* delete, but it needs the page size; getCurrentFilePath
  // / getCurrentPageNum / getPageSize are safe to call any time.
  //
  // recognizeElements expects the *page* size (not the lasso rect). Native
  // stack from logcat 04-26 15:13:22 line 19985:
  //   IllegalArgumentException: getRealMaxX error, unknown pageSize: 390x348
  //     at PointUtils.getRealMaxX(PointUtils.java:294)
  //     at PluginRecognitionService.recognizeStroke(PluginRecognitionService.java:102)
  const notePath = expectSuccess(
    await comm.getCurrentFilePath(),
    'getCurrentFilePath',
  );
  const pageNum = expectSuccess(
    await comm.getCurrentPageNum(),
    'getCurrentPageNum',
  );
  const pageSize = expectSuccess(
    await file.getPageSize(notePath, pageNum),
    'getPageSize',
  );
  logger.log(
    `[formula:page] ${notePath} page=${pageNum} size=${pageSize.width}x${pageSize.height}`,
  );

  // Delete BEFORE recognize. recognizeElements (or any save in between)
  // ends the lasso state — see logcat 04-26 16:00:43 line 30714 which
  // showed `deleteLassoElements` failing with "No lasso action has been
  // performed. Cannot call the API!" *after* a successful recognize.
  // The reference repo (guibor/supernote-shape-snap, executeFastPath in
  // src/shapeSnap.ts:454-471) also runs delete first.
  //
  // Recognize takes `elements` as an in-memory argument; the captured
  // Element[] from getLassoElements above is sufficient input for it.
  const deleteRes = await comm.deleteLassoElements();
  if (!deleteRes || !deleteRes.success) {
    const msg = deleteRes?.error?.message ?? 'no error message';
    logger.error(`[formula:delete] failed: ${msg}`);
    return { outcome: 'delete-failed' };
  }
  logger.log('[formula:delete] ok');

  const recognizeRes = await comm.recognizeElements(elements, pageSize);
  if (!recognizeRes || !recognizeRes.success) {
    const msg = recognizeRes?.error?.message ?? 'no error message';
    logger.error(
      `[formula:recognize] failed: ${msg} — strokes already deleted; user must undo to recover`,
    );
    return { outcome: 'recognizer-failed' };
  }
  const recognized = recognizeRes.result ?? '';
  logger.log(`[formula:recognize] text=${JSON.stringify(recognized)}`);
  if (recognized.length === 0) {
    logger.warn(
      '[formula] recognizer returned empty — strokes already deleted; user must undo to recover',
    );
    return { outcome: 'recognizer-empty', recognized };
  }

  const fontSize = deriveFontSize(rect, recognized.length);
  const textRect = widenRectForText(rect, fontSize, recognized.length);
  logger.log(
    `[formula:textbox] fontSize=${fontSize} rect=${textRect.left},${textRect.top} ${rectWidth(textRect)}x${rectHeight(textRect)}`,
  );
  const insertRes = await note.insertText({
    textContentFull: recognized,
    textRect,
    fontSize,
    textAlign: 0,
    textBold: 0,
    textItalics: 0,
    // 1 = auto-width: the text box grows to fit `textContentFull`. On the
    // tested firmware this did not actually expand the render area, so
    // `widenRectForText` above is the load-bearing guard. We still set
    // this in case it helps on other firmware revisions.
    textFrameWidthType: 1,
  });
  if (!insertRes || !insertRes.success) {
    const msg = insertRes?.error?.message ?? 'no error message';
    logger.error(
      `[formula:insert] failed: ${msg} — strokes already deleted; user must undo to recover`,
    );
    return { outcome: 'insert-failed', recognized };
  }
  logger.log('[formula:insert] ok');

  // Release the lasso state inline on the success path, matching
  // guibor/supernote-shape-snap's executeFastPath ordering. Soft-warn on
  // failure: the host appears to auto-clear lasso state after delete+insert
  // so this can return success=false (status:0) without consequence — but
  // skipping it on the success path leaves the gesture chain dangling and
  // the device hangs with "Got DOWN touch before receiving UP or CANCEL"
  // (logcat 04-26 16:20:11 onwards).
  const lassoRes = await comm.setLassoBoxState(2);
  if (!lassoRes || !lassoRes.success) {
    const msg = lassoRes?.error?.message ?? 'no error message';
    logger.warn(
      `[formula:lasso-box] setLassoBoxState(2) returned success=false: ${msg}`,
    );
  } else {
    logger.log('[formula:lasso-box] ok');
  }

  logger.log(`[formula] replaced lasso with ${JSON.stringify(recognized)}`);
  return { outcome: 'replaced', recognized };
};

// Filename of the icon staged by buildPlugin.sh inside the plugin's
// runtime data dir. PluginConfig.json's iconPath becomes `/icon.png` at
// build time, so the runtime path is `<pluginDir>/icon.png`. The button's
// `icon` field expects a `file://` URI to that path (see Sticker plugin
// registration in logcat: `file:///data/user/0/.../drawable-mdpi/assets_icon.png`).
const ICON_FILENAME = 'icon.png';

const buildIconUri = (pluginDir: string | null | undefined): string =>
  pluginDir ? `file://${pluginDir}/${ICON_FILENAME}` : '';

// We intentionally do NOT set `isHideToolbar: true`. Hiding the lasso
// toolbar mid-press interrupts the gesture lifecycle on the tested
// firmware — the host never delivers UP/CANCEL to RN, leaving the device
// hung. Reference plugin guibor/supernote-shape-snap also omits this and
// relies on `setLassoBoxState(2)` (called inline after the edit) to
// release the lasso state cleanly.
const buildFormulaButton = (iconUri: string): PluginButton => ({
  id: FORMULA_BUTTON_ID,
  name: 'Formula',
  icon: iconUri,
  enable: true,
  editDataTypes: [STROKE_DATA_TYPE],
});

export type SpikeDeps = {
  pluginManager: PluginManagerLike;
  commAPI: CommAPILike;
  noteAPI: NoteAPILike;
  fileAPI: FileAPILike;
  logger: Logger;
};

// Visible error UX (dialogs / toasts) is intentionally deferred until
// after spike 1.3 resolves. NativeUIUtils.showRattaDialog corrupts the
// plugin host's input channel when called from the RN module thread —
// see logcat 04-26 15:22:13 around line 26442 (Window has no registered
// input channel) following dialog onDismiss on Thread:mqt_native_modules.
// For v1 we will surface errors via a plugin view region (regionType >= 1)
// rendered in React Native, which is the path sibling plugins use.

// Module-level reentrancy guard. Matches the `isSnapping` pattern in
// guibor/supernote-shape-snap (src/shapeSnap.ts:103). A double-tap on
// Formula while the pipeline is mid-flight would otherwise issue
// overlapping `deleteLassoElements` + `recognizeElements` calls.
let isProcessing = false;

const closePluginView = async (
  deps: SpikeDeps,
): Promise<void> => {
  try {
    const res = await deps.pluginManager.closePluginView();
    if (!res) {
      deps.logger.warn('[formula:close] closePluginView returned falsy');
    }
  } catch (e) {
    deps.logger.warn(
      `[formula:close] closePluginView threw: ${(e as Error).message}`,
    );
  }
};

const onPress = async (
  deps: SpikeDeps,
  event: ButtonEvent,
): Promise<void> => {
  if (event.id !== FORMULA_BUTTON_ID) {
    deps.logger.warn(`[formula] ignoring unknown button id=${event.id}`);
    return;
  }
  if (isProcessing) {
    deps.logger.warn('[formula] pipeline already running — ignoring re-entry');
    // The host has already added its overlay window for this tap (logcat
    // line shows `addWindow win:Window{... pluginhost}` immediately
    // before sendMenuItemEvent). Even though we're rejecting the run,
    // we must release that window or the device hangs.
    await closePluginView(deps);
    return;
  }
  isProcessing = true;
  try {
    await runFormulaPipeline(
      deps.commAPI,
      deps.noteAPI,
      deps.fileAPI,
      deps.logger,
    );
  } catch (e) {
    deps.logger.error(`[formula] pipeline crashed: ${(e as Error).message}`);
  } finally {
    // Clear the reentrancy flag SYNCHRONOUSLY before awaiting
    // closePluginView. The host transitions the plugin app to
    // `state:stop` after the view is set GONE, which can suspend the
    // JS context — if we cleared the flag *after* the await, that
    // assignment may never run and the flag stays stuck `true`,
    // rejecting every subsequent press (logcat 04-26 17:12:49:
    // "pipeline already running" 2 minutes after a clean cleanup).
    isProcessing = false;
    // Always close the plugin host window. Without this the host's
    // overlay window keeps capturing pen touches at the OS
    // InputDispatcher layer (logcat 04-26 16:59:58.001 `addWindow
    // win:Window{... com.ratta.supernote.pluginhost}`).
    await closePluginView(deps);
  }
};

/**
 * Registers the Formula lasso button and a single dispatching listener.
 * Resolves the plugin's data dir at registration time so the button can
 * reference its packaged icon via a `file://` URI.
 */
export const registerFormulaButton = async (
  deps: SpikeDeps,
): Promise<void> => {
  let pluginDir: string | null | undefined;
  try {
    pluginDir = await deps.pluginManager.getPluginDirPath();
  } catch (e) {
    deps.logger.warn(
      `[formula:icon] getPluginDirPath threw: ${(e as Error).message} — registering without icon`,
    );
    pluginDir = null;
  }
  const iconUri = buildIconUri(pluginDir);
  if (!iconUri) {
    deps.logger.warn(
      '[formula:icon] no plugin dir available — button will render without icon',
    );
  }
  // Success path is intentionally silent: the native host logs the full
  // registered button payload (including this icon URI) on the
  // registerButton call, so duplicating it here adds no signal.
  await deps.pluginManager.registerButton(
    LASSO_BUTTON_TYPE,
    APP_TYPES,
    buildFormulaButton(iconUri),
  );
  deps.pluginManager.registerButtonListener({
    onButtonPress: (event) => {
      // Fire-and-forget: the listener returns synchronously, matching
      // guibor/supernote-shape-snap's listener pattern (index.js:50-66).
      // Awaiting here can keep the host blocked on the gesture lifecycle.
      onPress(deps, event).catch((e: Error) => {
        deps.logger.error(`[formula] dispatch crashed: ${e.message}`);
      });
    },
  });
};
