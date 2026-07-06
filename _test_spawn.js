const {spawn} = require('child_process');
process.env.PATH = 'D:\\Tools;' + (process.env.PATH || '');

// Test 1: directly spawning claude from D:\Tools
const child = spawn('claude', ['--version'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env}
});
let out = '', err = '';
child.stdout.on('data', d => out += d);
child.stderr.on('data', d => err += d);
child.on('error', e => console.log('SPAWN_ERROR:', e.message));
child.on('close', code => console.log('EXIT:', code, 'OUT:', JSON.stringify(out.trim()), 'ERR:', JSON.stringify(err.trim())));

// Also test: which executable would be resolved
const {execSync} = require('child_process');
try {
    const which = execSync('where claude', {encoding: 'utf8', shell: 'cmd.exe'});
    console.log('WHERE:', which.trim().split('\r\n'));
} catch(e) {
    console.log('WHERE failed:', e.message);
}
