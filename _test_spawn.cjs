const { spawn, execSync } = require('child_process');
process.env.PATH = 'D:\\Tools;' + (process.env.PATH || '');

const child = spawn('claude', ['--version'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
});
let out = '', err = '';
child.stdout.on('data', d => out += d);
child.stderr.on('data', d => err += d);
child.on('error', e => console.log('SPAWN_ERROR:', e.message));
child.on('close', code => console.log('EXIT:', code, 'OUT:', JSON.stringify(out.trim()), 'ERR:', JSON.stringify(err.trim())));

try {
    const w = execSync('where claude', { encoding: 'utf8', shell: 'cmd.exe' });
    console.log('WHERE:', w.trim().split('\r\n'));
} catch (e) {
    console.log('WHERE failed:', e.message);
}
