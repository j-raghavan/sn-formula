import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {
  PluginManager,
  PluginCommAPI,
  PluginNoteAPI,
  PluginFileAPI,
} from 'sn-plugin-lib';

// PluginCommAPI / PluginNoteAPI / PluginFileAPI are wired as-is into the
// spike orchestrator below; the orchestrator depends only on the methods
// it actually calls (declared as `*Like` interfaces in src/spike.ts), so
// the static method shapes match by structural typing.
import {registerFormulaButton} from './src/spike';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

registerFormulaButton({
  pluginManager: PluginManager,
  commAPI: PluginCommAPI,
  noteAPI: PluginNoteAPI,
  fileAPI: PluginFileAPI,
  logger: console,
});

// PluginManager.closePluginView is structurally typed against
// PluginManagerLike — its presence is checked at runtime via the deps
// object above; no explicit typing needed here.
