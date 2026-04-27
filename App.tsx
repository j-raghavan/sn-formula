import React from 'react';
import {StyleSheet, View} from 'react-native';

// v1 has no popup UI: the lasso-toolbar "Formula" button (Phase 1 spike,
// see sn-formula-requirement.md §4.2) runs the OCR pipeline inline and
// replaces strokes with a TextBox via PluginNoteAPI.insertText.
//
// The View must be non-interactive (pointerEvents="none") AND zero-sized.
// Otherwise the plugin host renders our invisible root over the note and
// silently intercepts pen DOWN events, never delivers matching UP/CANCEL,
// and RN's gesture system corrupts:
//   "Got DOWN touch before receiving UP or CANCEL from last gesture"
// (logcat 04-26 16:49:17.421). After that every pen tap is dropped and
// the device appears hung. Confirmed root cause of the post-pipeline hang
// we chased through editDataTypes, isHideToolbar, setLassoBoxState, and
// re-entry guards — none of which were the actual culprit.
const styles = StyleSheet.create({
  hidden: {width: 0, height: 0},
});

export default function App(): React.JSX.Element {
  return <View pointerEvents="none" style={styles.hidden} />;
}
