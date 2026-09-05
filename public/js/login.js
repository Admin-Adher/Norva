document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    try {
        const response = await API.request('POST', '/auth/login', { username, password });
        localStorage.setItem('sessionToken', response.token);
        window.location.href = '/';
    } catch (err) {
        document.getElementById('login-error').textContent = (globalThis.NorvaI18n?.t("ui_web_b26beb014af8", { defaultValue: "Login failed. Check your details and try again." }) ?? 'Login failed. Check your details and try again.');
    }
});
