import { defineConfig, loadEnv } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const ROBOT_ALIASES = {
    g1: 'unitree_g1',
    unitree_g1: 'unitree_g1',
    microduck: 'microduck',
};

const ROBOT_ROOTS = ['public/robots', 'public'];

function listRobotKeys() {
    const keys = new Set();
    for (const root of ROBOT_ROOTS) {
        if (!fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                keys.add(entry.name);
            }
        }
    }
    return keys;
}

function resolveRobotFolder(robot) {
    const keys = listRobotKeys();
    const mapped = ROBOT_ALIASES[robot] || robot;
    if (keys.has(mapped)) return mapped;
    if (keys.has(robot)) return robot;
    const prefixed = `unitree_${robot}`;
    if (keys.has(prefixed)) return prefixed;
    throw new Error(
        `VITE_ROBOT="${robot}" is not a folder under public/ or public/robots/. Found: ${[...keys].join(', ') || '(none)'}`,
    );
}

function copySelectedRobotPublicAssets(robotKey) {
    return {
        name: 'copy-selected-robot-public-assets',
        apply: 'build',
        closeBundle() {
            const publicDir = path.resolve('public');
            const outDir = path.resolve('dist');
            if (!fs.existsSync(publicDir)) return;

            const robot = resolveRobotFolder(robotKey);
            const robotKeys = listRobotKeys();

            const walk = (src, dest) => {
                fs.mkdirSync(dest, { recursive: true });
                for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                    const from = path.join(src, entry.name);
                    const to = path.join(dest, entry.name);
                    const rel = path.relative(publicDir, from).replaceAll('\\', '/');

                    const parts = rel.split('/');
                    const underRobots = parts[0] === 'robots';
                    const folderName = underRobots ? parts[1] : parts[0];
                    const isRobotTree =
                        (underRobots && parts[1] && robotKeys.has(parts[1])) ||
                        (!underRobots && robotKeys.has(parts[0]));

                    if (isRobotTree && folderName !== robot) continue;

                    if (entry.isDirectory()) walk(from, to);
                    else fs.copyFileSync(from, to);
                }
            };

            walk(publicDir, outDir);
        },
    };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const robot = env.VITE_ROBOT || 'g1';

    return {
        publicDir: 'public',
        server: {
            port: 5173,
            open: true,
            headers: {
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
            },
        },
        preview: {
            host: true,
            port: Number(process.env.PORT) || 4173,
            strictPort: true,
            allowedHosts: ['www.sp4wn.com', 'sp4wn.com', '.onrender.com'],
            headers: {
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
            },
        },
        build: {
            target: 'esnext',
            outDir: 'dist',
            assetsInlineLimit: 0,
            copyPublicDir: false,
            chunkSizeWarningLimit: 12000,
            reportCompressedSize: false,
        },
        assetsInclude: ['**/*.wasm'],
        optimizeDeps: {
            exclude: ['@mujoco/mujoco'],
        },
        plugins: [copySelectedRobotPublicAssets(robot)],
    };
});