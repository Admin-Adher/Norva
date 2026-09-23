'use strict';

// Keep JPEG compatibility and tile geometry across web, Android and TV.
// Apply only to the final sprite: private checkpoint images keep their quality
// so repeated viewer preemptions never introduce additional compression loss.
function storyboardEncodingArgs() {
    return ['-c:v', 'mjpeg', '-q:v', '8', '-pix_fmt', 'yuvj420p', '-threads', '1'];
}

module.exports = { storyboardEncodingArgs };
