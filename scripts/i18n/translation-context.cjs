'use strict';
// Disambiguation for draft translation only. The English UI and catalog identity remain unchanged.
module.exports = source => source
 .replace(/on deck/g, 'in the download queue')
 .replace(/Preparing your next watch/g, 'Preparing your next video')
 .replace(/Download rules/g, 'Download settings')
 .replace(/download rules/g, 'download settings')
 .replace(/Only download over Wi-Fi[ —;]+saves mobile data/g, 'Download only using Wi-Fi to reduce mobile data usage')
 .replace(/Only download over Wi-Fi; saves mobile data/g, 'Download only using Wi-Fi to reduce mobile data usage')
 .replace(/%([1-9])\$s free/g, '%$1$s of storage available')
 .replace(/%([1-9])\$s used/g, '%$1$s of storage used')
 .replace(/Play (?=%|\{\{)/g, 'Watch ')
 .replace(/Playing in /g, 'Video playback starts in ')
 .replace(/Delete controls shown/g, 'Deletion buttons are visible')
 .replace(/Delete controls hidden/g, 'Deletion buttons are hidden')
 .replace(/saved title(s?)/g, 'downloaded video$1');
