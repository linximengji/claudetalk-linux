import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
export function getPhoneTasksDir() {
    return process.env.TEST_PHONE_TASKS_DIR
        ? resolve(process.env.TEST_PHONE_TASKS_DIR)
        : resolve(__dirname, '..', '..', '..', 'tasks');
}
export const OPS_DAEMON_DIR = resolve(__dirname, '..', '..', '..', 'ops-daemon');
//# sourceMappingURL=paths.js.map