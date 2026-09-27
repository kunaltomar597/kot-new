import { registerAlertKeepAlive } from '@rp/mobile-native';
import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';
import { Root } from './src/Root';
import { deviceSession } from './src/session';

// Registers the app as `main`, the name the native project starts (Expo development builds).
registerRootComponent(Root);

// The task the alert service runs to keep the phone listening with the screen off (P2-06b). After
// Android restarted the service in a new process, it is what starts the device session.
registerAlertKeepAlive(AppRegistry.registerHeadlessTask, deviceSession);
