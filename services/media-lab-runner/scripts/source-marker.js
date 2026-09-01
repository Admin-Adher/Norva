'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function canonicalSourceBytes(filePath) {
    const body = fs.readFileSync(filePath);
    if (body.includes(0)) throw new Error(`MEDIA_LAB_SOURCE_MARKER_BINARY_FILE:${filePath}`);
    return Buffer.from(body.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function runnerSourceFiles(projectRoot) {
    const files = [
        'services/media-lab-runner/Dockerfile',
        'services/media-lab-runner/package.json',
        'services/media-lab-runner/package-lock.json',
        'services/media-gateway/src/ocr_pgs.py',
        'public/js/vendor/hls-1.5.7.min.js',
    ];
    const walk = (relativeDirectory) => {
        for (const entry of fs.readdirSync(path.join(projectRoot, relativeDirectory), { withFileTypes: true })) {
            const relativePath = path.posix.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) walk(relativePath);
            else if (entry.isFile()) files.push(relativePath);
        }
    };
    for (const directory of [
        'services/media-lab-runner/src',
        'services/media-lab-runner/scripts',
        'services/media-lab-runner/fixtures',
    ]) walk(directory);
    return Object.freeze(files.sort());
}

function runnerSourceDigest(projectRoot = path.join(__dirname, '..', '..', '..')) {
    const manifest = runnerSourceFiles(projectRoot).map((relativePath) => {
        const digest = crypto.createHash('sha256')
            .update(canonicalSourceBytes(path.join(projectRoot, relativePath)))
            .digest('hex');
        return `${digest}  ${relativePath}\n`;
    }).join('');
    return crypto.createHash('sha256').update(manifest).digest('hex');
}

if (require.main === module) process.stdout.write(`${runnerSourceDigest()}\n`);

module.exports = Object.freeze({
    canonicalSourceBytes,
    runnerSourceDigest,
    runnerSourceFiles,
});
