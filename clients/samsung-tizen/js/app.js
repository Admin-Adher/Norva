(function () {
    var STORAGE_KEY = 'nodecastServerUrl';
    var setup = document.getElementById('setup');
    var viewer = document.getElementById('viewer');
    var frame = document.getElementById('nodecast-frame');
    var input = document.getElementById('server-url');
    var connect = document.getElementById('connect');
    var clear = document.getElementById('clear');
    var settings = document.getElementById('settings');
    var hint = document.getElementById('hint');

    function normalizeUrl(value) {
        var url = String(value || '').trim();
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
        return url.replace(/\/+$/, '');
    }

    function showSetup(message) {
        viewer.classList.add('hidden');
        setup.classList.remove('hidden');
        frame.removeAttribute('src');
        hint.textContent = message || 'Example: http://192.168.1.42:3000';
        setTimeout(function () { input.focus(); }, 60);
    }

    function openServer(url) {
        var normalized = normalizeUrl(url);
        localStorage.setItem(STORAGE_KEY, normalized);
        setup.classList.add('hidden');
        viewer.classList.remove('hidden');
        frame.src = normalized;
        setTimeout(function () { frame.focus(); }, 250);
    }

    connect.addEventListener('click', function () {
        openServer(input.value);
    });

    clear.addEventListener('click', function () {
        localStorage.removeItem(STORAGE_KEY);
        input.value = 'http://192.168.1.10:3000';
        showSetup('Saved server URL cleared.');
    });

    settings.addEventListener('click', function () {
        showSetup('Update the Norva server URL.');
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' || event.key === 'Backspace' || event.keyCode === 10009) {
            if (!setup.classList.contains('hidden')) return;
            event.preventDefault();
            showSetup('Update the Norva server URL.');
        }
    });

    if (window.tizen && tizen.tvinputdevice) {
        try {
            tizen.tvinputdevice.registerKey('Return');
        } catch (e) {
            // Some emulator builds already register Return.
        }
    }

    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        input.value = saved;
        openServer(saved);
    } else {
        showSetup();
    }
})();
