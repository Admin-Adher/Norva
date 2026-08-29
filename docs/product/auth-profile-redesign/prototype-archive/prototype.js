(function () {
  'use strict';

  const googleMark = '<svg class="google-mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3A12 12 0 1 1 32 15l5.7-5.6A20 20 0 1 0 44 24c0-1.3-.1-2.6-.4-3.9Z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C41.2 35.3 44 30.1 44 24c0-1.3-.1-2.6-.4-3.9Z"/></svg>';

  document.querySelectorAll('[data-auth-render]').forEach((host) => {
    const prefix = host.dataset.prefix || 'prototype';
    const signupIntro = host.dataset.signupIntro || 'Start with Google or use your email. Your TV service is connected later.';
    const signinIntro = host.dataset.signinIntro || 'Sign in to reconnect your Norva screens.';
    host.innerHTML = `
      <div class="auth-tabs" role="tablist" aria-label="Account access">
        <button class="auth-tab" id="${prefix}-signin-tab" type="button" role="tab" aria-selected="false" aria-controls="${prefix}-signin" data-mode="signin">Sign in</button>
        <button class="auth-tab" id="${prefix}-signup-tab" type="button" role="tab" aria-selected="true" aria-controls="${prefix}-signup" data-mode="signup">Create account</button>
      </div>
      <section id="${prefix}-signin" role="tabpanel" aria-labelledby="${prefix}-signin-tab" data-mode="signin" hidden>
        <h2 class="form-heading">Welcome back</h2>
        <p class="form-intro">${signinIntro}</p>
        <form class="auth-form">
          <div class="field"><label for="${prefix}-signin-email">Email</label><input id="${prefix}-signin-email" type="email" autocomplete="email" placeholder="name@example.com" required></div>
          <div class="field"><label for="${prefix}-signin-password">Password</label><input id="${prefix}-signin-password" type="password" autocomplete="current-password" required></div>
          <button class="action action-primary" type="submit">Sign in</button>
          <button class="action-link" type="button" data-prototype-action>Forgot password</button>
          <div class="divider">or</div>
          <button class="action action-google" type="button" data-prototype-action>${googleMark}Continue with Google</button>
          <p class="prototype-status" data-status aria-live="polite"></p>
        </form>
      </section>
      <section id="${prefix}-signup" role="tabpanel" aria-labelledby="${prefix}-signup-tab" data-mode="signup">
        <h2 class="form-heading">Create your Norva account</h2>
        <p class="form-intro">${signupIntro}</p>
        <form class="auth-form">
          <button class="action action-google" type="button" data-prototype-action>${googleMark}Continue with Google</button>
          <div class="divider">or</div>
          <button class="action action-secondary" type="button" data-reveal-email>Continue with email</button>
          <div class="email-fields" data-email-fields hidden>
            <div class="field"><label for="${prefix}-signup-email">Email</label><input id="${prefix}-signup-email" type="email" autocomplete="email" placeholder="name@example.com" required></div>
            <div class="field"><label for="${prefix}-signup-password">Password</label><input id="${prefix}-signup-password" type="password" autocomplete="new-password" minlength="6" required></div>
            <button class="action action-primary" type="submit">Create account</button>
          </div>
          <p class="prototype-status" data-status aria-live="polite"></p>
        </form>
      </section>
      <p class="fine-print">Norva is a media player and includes no content. Connect only a compatible source you own or are authorized to use.</p>
      <nav class="legal-links" aria-label="Legal"><a href="#">Privacy</a><a href="#">Terms</a></nav>`;
  });

  const params = new URLSearchParams(window.location.search);
  const requestedDensity = params.has('density')
    ? Number(params.get('density'))
    : Number.NaN;
  const density = Number.isFinite(requestedDensity)
    ? Math.min(1.4, Math.max(0.6, requestedDensity))
    : 1;
  document.documentElement.style.setProperty('--p-density', String(density));
  document.body.dataset.pDensity = String(density);

  const requestedFontScale = Number(params.get('fontScale'));
  if (Number.isFinite(requestedFontScale)) {
    const fontScale = Math.min(1.3, Math.max(1, requestedFontScale));
    document.documentElement.style.fontSize = `${16 * fontScale}px`;
  }

  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
  const variant = document.body.dataset.variant || 'a';

  function setMode(mode, focusPanel) {
    tabs.forEach((tab) => {
      const selected = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });

    panels.forEach((panel) => {
      const selected = panel.dataset.mode === mode;
      panel.hidden = !selected;
      if (selected && focusPanel) {
        const target = panel.querySelector('input, button');
        if (target) target.focus({ preventScroll: true });
      }
    });

    document.body.dataset.mode = mode;
    const proofTitle = document.querySelector('[data-proof-title]');
    if (proofTitle) {
      proofTitle.textContent = mode === 'signup'
        ? 'Why create a Norva account?'
        : 'Your screens reconnect after sign-in.';
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode, true));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      setMode(next.dataset.mode, false);
      next.focus();
    });
  });

  document.querySelectorAll('[data-reveal-email]').forEach((button) => {
    button.addEventListener('click', () => {
      const panel = button.closest('[role="tabpanel"]');
      const fields = panel && panel.querySelector('[data-email-fields]');
      if (!fields) return;
      fields.hidden = false;
      button.hidden = true;
      const email = fields.querySelector('input[type="email"]');
      if (email) email.focus();
    });
  });

  document.querySelectorAll('form').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const status = form.querySelector('[data-status]');
      if (status) {
        status.textContent = 'Prototype uniquement — aucun compte ni message n’a été créé.';
      }
    });
  });

  document.querySelectorAll('[data-prototype-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const scope = button.closest('[role="tabpanel"], form, .door-form-inner');
      const status = scope && scope.querySelector('[data-status]');
      if (status) {
        status.textContent = 'Prototype uniquement — aucune connexion externe n’a été lancée.';
      }
    });
  });

  const defaultMode = params.get('mode') === 'signin' ? 'signin' : 'signup';
  setMode(defaultMode, false);

  const hWelcome = document.querySelector('[data-h-view="welcome"]');
  const hAuth = document.querySelector('[data-h-view="auth"]');
  if (hWelcome && hAuth) {
    let hMode = 'signup';
    const hTitle = document.querySelector('[data-h-title]');
    const hCopy = document.querySelector('[data-h-copy]');
    const hSubmit = document.querySelector('[data-h-submit]');
    const hSwitch = document.querySelector('[data-h-switch]');
    const hEmail = document.getElementById('h-email');

    function renderHMode(mode) {
      hMode = mode;
      const signin = mode === 'signin';
      hTitle.textContent = signin ? 'Welcome back' : 'Create your Norva account';
      hCopy.textContent = signin
        ? 'Sign in to reconnect your Norva screens.'
        : 'Choose the quickest way to create your account.';
      hSubmit.textContent = signin ? 'Continue to sign in' : 'Continue with email';
      hSwitch.innerHTML = signin
        ? 'New to Norva? <strong>Create account</strong>'
        : 'Already have an account? <strong>Sign in</strong>';
    }

    document.querySelectorAll('[data-h-open]').forEach((button) => {
      button.addEventListener('click', () => {
        renderHMode(button.dataset.hOpen === 'signin' ? 'signin' : 'signup');
        hWelcome.hidden = true;
        hAuth.hidden = false;
        window.scrollTo({ top: 0, behavior: 'auto' });
        if (hEmail) hEmail.focus({ preventScroll: true });
      });
    });

    document.querySelector('[data-h-back]').addEventListener('click', () => {
      hAuth.hidden = true;
      hWelcome.hidden = false;
      const target = document.querySelector(`[data-h-open="${hMode}"]`);
      if (target) target.focus({ preventScroll: true });
    });

    hSwitch.addEventListener('click', () => {
      renderHMode(hMode === 'signin' ? 'signup' : 'signin');
      if (hEmail) hEmail.focus({ preventScroll: true });
    });

    renderHMode('signup');
  }

  const iIdentityForm = document.querySelector('[data-i-identity-form]');
  if (iIdentityForm) {
    const identityStep = document.querySelector('[data-i-step="identity"]');
    const credentialStep = document.querySelector('[data-i-step="credential"]');
    const emailInput = document.getElementById('i-email');
    const emailValue = document.querySelector('[data-i-email-value]');
    const backButton = document.querySelector('[data-i-back]');
    const progress = document.querySelector('[data-i-progress]');
    const passwordInput = document.getElementById('i-password');

    function showIdentityStep() {
      credentialStep.hidden = true;
      identityStep.hidden = false;
      backButton.hidden = true;
      progress.textContent = 'Account access';
      emailInput.focus({ preventScroll: true });
    }

    iIdentityForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!iIdentityForm.reportValidity()) return;
      emailValue.textContent = emailInput.value.trim();
      identityStep.hidden = true;
      credentialStep.hidden = false;
      backButton.hidden = false;
      progress.textContent = 'Secure sign in';
      passwordInput.focus({ preventScroll: true });
    });

    backButton.addEventListener('click', showIdentityStep);
    document.querySelector('[data-i-change]').addEventListener('click', showIdentityStep);

    const passwordToggle = document.querySelector('[data-password-toggle]');
    passwordToggle.addEventListener('click', () => {
      const reveal = passwordInput.type === 'password';
      passwordInput.type = reveal ? 'text' : 'password';
      passwordToggle.textContent = reveal ? 'Hide' : 'Show';
      passwordToggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      passwordInput.focus({ preventScroll: true });
    });
  }

  const jEmailButton = document.querySelector('[data-j-email]');
  if (jEmailButton) {
    const jFields = document.querySelector('[data-j-email-fields]');
    jEmailButton.addEventListener('click', () => {
      jEmailButton.hidden = true;
      jFields.hidden = false;
      const input = jFields.querySelector('input');
      if (input) input.focus({ preventScroll: true });
    });
  }

  const kEmailForm = document.querySelector('[data-k-email-form]');
  if (kEmailForm) {
    const emailStep = document.querySelector('[data-k-step="email"]');
    const codeStep = document.querySelector('[data-k-step="code"]');
    const kEmail = document.getElementById('k-email');
    const kCode = document.getElementById('k-code');
    const kEmailValue = document.querySelector('[data-k-email-value]');

    function showCodeEmail() {
      codeStep.hidden = true;
      emailStep.hidden = false;
      kEmail.focus({ preventScroll: true });
    }

    kEmailForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!kEmailForm.reportValidity()) return;
      kEmailValue.textContent = kEmail.value.trim();
      emailStep.hidden = true;
      codeStep.hidden = false;
      kCode.focus({ preventScroll: true });
    });

    document.querySelector('[data-k-back]').addEventListener('click', showCodeEmail);
  }

  const lIdentityForm = document.querySelector('[data-l-identity-form]');
  if (lIdentityForm) {
    const welcomeView = document.querySelector('[data-l-view="welcome"]');
    const authView = document.querySelector('[data-l-view="auth"]');
    const profileView = document.querySelector('[data-l-view="profiles"]');
    const profileScreens = Array.from(document.querySelectorAll('[data-profile-screen]'));
    const profileBackButton = document.querySelector('[data-profile-back]');
    const profileManageButton = document.querySelector('[data-profile-manage]');
    const profileStatus = document.querySelector('[data-profile-status]');
    const profileLoadingName = document.querySelector('[data-profile-loading-name]');
    const profileLoadingAvatar = document.querySelector('[data-profile-loading-avatar]');
    const profileArrivalName = document.querySelector('[data-profile-arrival-name]');
    const profileEditorAvatars = Array.from(document.querySelectorAll('[data-profile-editor-avatar]'));
    const profileCreatedAvatar = document.querySelector('[data-profile-created-avatar]');
    const profileSetupTitle = document.getElementById('profile-setup-title');
    const profileSetupCopy = document.querySelector('[data-profile-screen="setup"] .profile-heading-group > p:last-child');
    const profileSetupName = document.getElementById('profile-setup-name');
    const profileEditName = document.getElementById('profile-edit-name');
    const profileSkipButton = document.querySelector('[data-profile-skip]');
    const identityStep = document.querySelector('[data-l-step="identity"]');
    const codeStep = document.querySelector('[data-l-step="code"]');
    const credentialStep = document.querySelector('[data-l-step="credential"]');
    const emailInput = document.getElementById('l-email');
    const passwordInput = document.getElementById('l-password');
    const codeEmailValue = document.querySelector('[data-l-code-email-value]');
    const credentialEmailValue = document.querySelector('[data-l-credential-email-value]');
    const codeTitle = document.querySelector('[data-l-code-title]');
    const codeCopy = document.querySelector('[data-l-code-copy]');
    const backButton = document.querySelector('[data-l-back]');
    const codeChangeButton = document.querySelector('[data-l-code-change]');
    const credentialChangeButton = document.querySelector('[data-l-credential-change]');
    const progressOne = document.querySelector('[data-l-progress-one]');
    const progressTwo = document.querySelector('[data-l-progress-two]');
    const submitButton = document.querySelector('[data-l-submit]');
    const submitLabel = document.querySelector('[data-l-submit-label]');
    const submitArrow = document.querySelector('[data-l-submit-arrow]');
    const spinner = document.querySelector('[data-l-spinner]');
    const liveStatus = document.querySelector('[data-l-status]');
    const welcomeSlides = Array.from(document.querySelectorAll('[data-l-slide]'));
    const welcomeCopies = Array.from(document.querySelectorAll('[data-l-slide-copy]'));
    const welcomeDots = Array.from(document.querySelectorAll('[data-l-dot]'));
    const codeForm = document.querySelector('[data-l-code-form]');
    const otpGroup = document.querySelector('[data-l-otp-group]');
    const otpInputs = Array.from(document.querySelectorAll('[data-l-otp]'));
    const resendButton = document.querySelector('[data-l-resend]');
    const codeFeedback = document.querySelector('[data-l-code-feedback]');
    const codeFeedbackLabel = document.querySelector('[data-l-code-feedback-label]');
    const codeSpinner = codeFeedback.querySelector('.premium-code-spinner');
    const usePasswordButton = document.querySelector('[data-l-use-password]');
    const useCodeButton = document.querySelector('[data-l-use-code]');
    const requestedStep = params.get('step');
    const requestedEmail = (params.get('email') || '').trim();
    const requestedOtp = (params.get('otp') || '').replace(/\D/g, '').slice(0, 4);
    const requestedAccount = params.get('account') === 'new' ? 'new' : 'existing';
    const requestedProfile = params.get('profile') || '';
    let lookupTimer;
    let verificationTimer;
    let verificationStartTimer;
    let codeLocked = false;
    let lStep = 'identity';
    let accountMode = requestedAccount;
    let lSlide = 0;
    let pointerStartX = null;
    let profileScreen = 'chooser';
    let profileReturnScreen = 'chooser';
    let profileEditorMode = 'first';
    let selectedProfileName = 'Adrien';
    let selectedProfileAvatar = 'assets/avatars/avatar-02.png';
    let selectedAvatarId = '01';
    let profileArrivalTimer;

    function setLSlide(nextIndex) {
      const index = (nextIndex + welcomeSlides.length) % welcomeSlides.length;
      lSlide = index;
      welcomeSlides.forEach((slide, slideIndex) => {
        const active = slideIndex === index;
        slide.classList.toggle('is-active', active);
        slide.setAttribute('aria-hidden', String(!active));
      });
      welcomeCopies.forEach((copy, copyIndex) => {
        const active = copyIndex === index;
        copy.classList.toggle('is-active', active);
        copy.setAttribute('aria-hidden', String(!active));
      });
      welcomeDots.forEach((dot, dotIndex) => {
        const active = dotIndex === index;
        dot.setAttribute('aria-selected', String(active));
        dot.tabIndex = active ? 0 : -1;
      });
    }

    function profileAvatarPath(id) {
      return `assets/avatars/avatar-${String(id).padStart(2, '0')}.png`;
    }

    function setSelectedAvatar(id) {
      selectedAvatarId = String(id).padStart(2, '0');
      selectedProfileAvatar = profileAvatarPath(selectedAvatarId);
      profileEditorAvatars.forEach((image) => { image.src = selectedProfileAvatar; });
      if (profileCreatedAvatar) profileCreatedAvatar.src = selectedProfileAvatar;
      document.querySelectorAll('[data-avatar-choice]').forEach((button) => {
        const selected = button.dataset.avatarChoice === selectedAvatarId;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
    }

    function configureProfileSetup(mode = 'first') {
      profileEditorMode = mode;
      const first = mode === 'first';
      profileSetupTitle.textContent = first ? 'Make it yours.' : 'Add a profile.';
      profileSetupCopy.textContent = first
        ? 'Name your first profile. You can change it later.'
        : 'Give each viewer a separate watchlist and progress.';
      profileSetupName.value = first ? 'Adrien' : '';
      profileSkipButton.hidden = !first;
      setSelectedAvatar(first ? '01' : '04');
    }

    function showProfileScreen(name, options = {}) {
      window.clearTimeout(profileArrivalTimer);
      welcomeView.hidden = true;
      authView.hidden = true;
      profileView.hidden = false;
      document.body.dataset.lView = 'profiles';
      profileScreen = name;

      if (name === 'setup') configureProfileSetup(options.mode || profileEditorMode || 'first');
      if (name === 'avatars' && options.returnTo) profileReturnScreen = options.returnTo;

      profileScreens.forEach((screen) => {
        screen.hidden = screen.dataset.profileScreen !== name;
      });

      const backTargets = new Set(['manage', 'edit', 'avatars']);
      profileBackButton.hidden = !backTargets.has(name);
      profileManageButton.hidden = name !== 'chooser';
      profileManageButton.textContent = 'Manage';
      profileStatus.textContent = 'Interactive prototype — no account or profile data is changed.';

      if (name === 'loading') {
        profileLoadingName.textContent = selectedProfileName;
        profileLoadingAvatar.src = selectedProfileAvatar;
        profileArrivalName.textContent = selectedProfileName;
        if (params.get('freeze') !== '1') {
          profileArrivalTimer = window.setTimeout(() => showProfileScreen('arrival'), 1050);
        }
      }

      const focusTarget = profileView.querySelector('[data-profile-screen]:not([hidden]) button, [data-profile-screen]:not([hidden]) input');
      if (focusTarget && options.focus !== false) {
        window.setTimeout(() => focusTarget.focus({ preventScroll: true }), 0);
      }
    }

    function openProfilePicker() {
      showProfileScreen('chooser');
    }

    function startProfile(name, avatar) {
      selectedProfileName = name || 'Adrien';
      selectedProfileAvatar = avatar || 'assets/avatars/avatar-02.png';
      showProfileScreen('loading');
    }

    function showLWelcome(focusTrigger) {
      window.clearTimeout(lookupTimer);
      window.clearTimeout(verificationTimer);
      window.clearTimeout(verificationStartTimer);
      window.clearTimeout(profileArrivalTimer);
      profileView.hidden = true;
      authView.hidden = true;
      welcomeView.hidden = false;
      document.body.dataset.lView = 'welcome';
      if (focusTrigger) {
        const trigger = welcomeView.querySelector('[data-l-open="signup"]');
        if (trigger) trigger.focus({ preventScroll: true });
      }
    }

    function showLAuth() {
      profileView.hidden = true;
      welcomeView.hidden = true;
      authView.hidden = false;
      document.body.dataset.lView = 'auth';
      showLIdentity();
    }

    function resetIdentitySubmit() {
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
      submitLabel.textContent = 'Continue';
      submitArrow.hidden = false;
      spinner.hidden = true;
    }

    function fillOtp(value) {
      const digits = String(value || '').replace(/\D/g, '').slice(0, otpInputs.length);
      otpInputs.forEach((input, index) => {
        input.value = digits[index] || '';
      });
    }

    function resolveLAccountMode() {
      if (params.get('account') === 'new') return 'new';
      const localPart = emailInput.value.trim().toLowerCase().split('@')[0];
      return /(^|[+._-])(new|nouveau|signup)([+._-]|$)/.test(localPart) ? 'new' : 'existing';
    }

    function setCodeBusy(isBusy) {
      codeLocked = isBusy;
      codeStep.classList.toggle('is-verifying', isBusy);
      codeStep.classList.remove('is-complete');
      if (isBusy) codeStep.setAttribute('aria-busy', 'true');
      else codeStep.removeAttribute('aria-busy');
      otpInputs.forEach((input) => { input.disabled = isBusy; });
      resendButton.disabled = isBusy;
      codeChangeButton.disabled = isBusy;
      usePasswordButton.disabled = isBusy;
      codeFeedback.hidden = !isBusy;
      codeSpinner.hidden = !isBusy;
      codeFeedbackLabel.textContent = 'Checking your code…';
    }

    function showLIdentity() {
      lStep = 'identity';
      window.clearTimeout(lookupTimer);
      window.clearTimeout(verificationTimer);
      window.clearTimeout(verificationStartTimer);
      resetIdentitySubmit();
      setCodeBusy(false);
      fillOtp('');
      codeStep.hidden = true;
      credentialStep.hidden = true;
      identityStep.hidden = false;
      backButton.hidden = false;
      backButton.setAttribute('aria-label', 'Back to welcome');
      progressOne.classList.remove('is-complete');
      progressOne.classList.add('is-current');
      progressTwo.classList.remove('is-current');
      liveStatus.textContent = '';
      emailInput.focus({ preventScroll: true });
    }

    function showLCode({ focus = true, value = '', mode = resolveLAccountMode() } = {}) {
      lStep = 'code';
      accountMode = mode;
      window.clearTimeout(lookupTimer);
      window.clearTimeout(verificationTimer);
      window.clearTimeout(verificationStartTimer);
      resetIdentitySubmit();
      setCodeBusy(false);
      fillOtp(value);
      codeEmailValue.textContent = emailInput.value.trim() || requestedEmail || 'name@example.com';
      codeTitle.textContent = accountMode === 'new' ? 'Create your account.' : 'Check your email.';
      codeCopy.textContent = accountMode === 'new'
        ? 'First, confirm your email with the 4-digit code.'
        : 'Enter the 4-digit code we sent you.';
      usePasswordButton.hidden = accountMode !== 'existing';
      identityStep.hidden = true;
      credentialStep.hidden = true;
      codeStep.hidden = false;
      backButton.hidden = false;
      backButton.setAttribute('aria-label', 'Back to email');
      progressOne.classList.add('is-complete');
      progressOne.classList.remove('is-current');
      progressTwo.classList.add('is-current');
      liveStatus.textContent = '';
      if (focus) {
        const target = otpInputs.find((input) => !input.value) || otpInputs[otpInputs.length - 1];
        target.focus({ preventScroll: true });
      }
    }

    function showLCredential() {
      lStep = 'credential';
      accountMode = 'existing';
      window.clearTimeout(lookupTimer);
      window.clearTimeout(verificationTimer);
      window.clearTimeout(verificationStartTimer);
      setCodeBusy(false);
      credentialEmailValue.textContent = emailInput.value.trim() || requestedEmail || 'name@example.com';
      identityStep.hidden = true;
      codeStep.hidden = true;
      credentialStep.hidden = false;
      backButton.hidden = false;
      backButton.setAttribute('aria-label', 'Back to secure code');
      progressOne.classList.add('is-complete');
      progressOne.classList.remove('is-current');
      progressTwo.classList.add('is-current');
      liveStatus.textContent = '';
      passwordInput.focus({ preventScroll: true });
    }

    function completeLVerification() {
      codeLocked = true;
      codeStep.classList.remove('is-verifying');
      codeStep.classList.add('is-complete');
      codeStep.removeAttribute('aria-busy');
      codeSpinner.hidden = true;
      codeFeedback.hidden = false;
      codeFeedbackLabel.textContent = accountMode === 'new'
        ? 'Email verified — account setup continues.'
        : 'Code accepted — loading your profiles.';
      codeChangeButton.disabled = false;
      liveStatus.textContent = 'Prototype only — no sign-in request was sent.';
      profileArrivalTimer = window.setTimeout(() => {
        if (accountMode === 'new') showProfileScreen('setup', { mode: 'first' });
        else openProfilePicker();
      }, 720);
    }

    function startLVerification({ fixture = false } = {}) {
      if (codeLocked || otpInputs.some((input) => !input.value)) return;
      window.clearTimeout(verificationStartTimer);
      setCodeBusy(true);
      liveStatus.textContent = 'Securely checking your code.';
      if (!fixture) verificationTimer = window.setTimeout(completeLVerification, 1350);
    }

    function queueLVerification() {
      window.clearTimeout(verificationStartTimer);
      if (otpInputs.every((input) => input.value)) {
        verificationStartTimer = window.setTimeout(() => startLVerification(), 180);
      }
    }

    lIdentityForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!lIdentityForm.reportValidity()) return;
      submitButton.disabled = true;
      submitButton.setAttribute('aria-busy', 'true');
      submitLabel.textContent = 'Sending your code…';
      submitArrow.hidden = true;
      spinner.hidden = false;
      liveStatus.textContent = 'Preparing a secure sign-in code.';
      lookupTimer = window.setTimeout(() => showLCode(), 720);
    });

    backButton.addEventListener('click', () => {
      if (lStep === 'code') showLIdentity();
      else if (lStep === 'credential') showLCode({ value: otpInputs.map((input) => input.value).join(''), mode: 'existing' });
      else showLWelcome(true);
    });
    codeChangeButton.addEventListener('click', showLIdentity);
    credentialChangeButton.addEventListener('click', showLIdentity);
    usePasswordButton.addEventListener('click', showLCredential);
    useCodeButton.addEventListener('click', () => {
      showLCode({ value: otpInputs.map((input) => input.value).join(''), mode: 'existing' });
    });

    otpInputs.forEach((input, index) => {
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(-1);
        if (input.value && otpInputs[index + 1]) otpInputs[index + 1].focus({ preventScroll: true });
        queueLVerification();
      });

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && !input.value && otpInputs[index - 1]) {
          otpInputs[index - 1].value = '';
          otpInputs[index - 1].focus({ preventScroll: true });
        } else if (event.key === 'ArrowLeft' && otpInputs[index - 1]) {
          event.preventDefault();
          otpInputs[index - 1].focus({ preventScroll: true });
        } else if (event.key === 'ArrowRight' && otpInputs[index + 1]) {
          event.preventDefault();
          otpInputs[index + 1].focus({ preventScroll: true });
        }
      });
    });

    otpGroup.addEventListener('paste', (event) => {
      const digits = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, otpInputs.length);
      if (!digits) return;
      event.preventDefault();
      fillOtp(digits);
      const target = otpInputs[Math.min(digits.length, otpInputs.length) - 1];
      target.focus({ preventScroll: true });
      queueLVerification();
    });

    codeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      startLVerification();
    });

    resendButton.addEventListener('click', () => {
      window.clearTimeout(verificationTimer);
      window.clearTimeout(verificationStartTimer);
      setCodeBusy(false);
      fillOtp('');
      liveStatus.textContent = 'A new 4-digit code was sent.';
      otpInputs[0].focus({ preventScroll: true });
    });

    const passwordToggle = document.querySelector('[data-l-password-toggle]');
    passwordToggle.addEventListener('click', () => {
      const reveal = passwordInput.type === 'password';
      passwordInput.type = reveal ? 'text' : 'password';
      passwordToggle.textContent = reveal ? 'Hide' : 'Show';
      passwordToggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      passwordInput.focus({ preventScroll: true });
    });

    document.querySelector('[data-l-credential-form]').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!event.currentTarget.reportValidity()) return;
      liveStatus.textContent = 'Prototype only — loading your profiles.';
      profileArrivalTimer = window.setTimeout(openProfilePicker, 520);
    });

    document.querySelectorAll('[data-l-open]').forEach((button) => {
      button.addEventListener('click', showLAuth);
    });

    welcomeDots.forEach((dot) => {
      dot.addEventListener('click', () => setLSlide(Number(dot.dataset.lDot)));
      dot.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        setLSlide(lSlide + (event.key === 'ArrowRight' ? 1 : -1));
        welcomeDots[lSlide].focus();
      });
    });

    welcomeView.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a')) return;
      pointerStartX = event.clientX;
    });

    welcomeView.addEventListener('pointerup', (event) => {
      if (pointerStartX === null) return;
      const delta = event.clientX - pointerStartX;
      pointerStartX = null;
      if (Math.abs(delta) < 46) return;
      setLSlide(lSlide + (delta < 0 ? 1 : -1));
    });

    document.querySelectorAll('[data-l-action]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        liveStatus.textContent = button.dataset.lAction === 'google'
          ? 'Prototype only — Google sign-in was not opened.'
          : 'Prototype only — the help centre was not opened.';
      });
    });

    profileManageButton.addEventListener('click', () => showProfileScreen('manage'));

    profileBackButton.addEventListener('click', () => {
      if (profileScreen === 'manage') showProfileScreen('chooser');
      else if (profileScreen === 'edit') showProfileScreen('manage');
      else if (profileScreen === 'avatars') showProfileScreen(profileReturnScreen || 'setup');
    });

    document.querySelectorAll('[data-profile-select]').forEach((button) => {
      button.addEventListener('click', () => {
        const avatar = button.querySelector('img');
        startProfile(button.dataset.profileSelect, avatar?.getAttribute('src'));
      });
    });

    document.querySelectorAll('[data-profile-add]').forEach((button) => {
      button.addEventListener('click', () => showProfileScreen('setup', { mode: 'add' }));
    });

    document.querySelectorAll('[data-profile-edit]').forEach((button) => {
      button.addEventListener('click', () => {
        const avatar = button.querySelector('img');
        selectedProfileName = button.dataset.profileEdit || 'Adrien';
        profileEditName.value = selectedProfileName;
        setSelectedAvatar((avatar?.getAttribute('src') || '').match(/avatar-(\d+)/)?.[1] || '02');
        showProfileScreen('edit');
      });
    });

    document.querySelector('[data-profile-done]').addEventListener('click', openProfilePicker);

    document.querySelectorAll('[data-profile-open-avatars]').forEach((button) => {
      button.addEventListener('click', () => {
        const returnTo = button.closest('[data-profile-screen]')?.dataset.profileScreen || 'setup';
        showProfileScreen('avatars', { returnTo });
      });
    });

    document.querySelectorAll('[data-avatar-choice]').forEach((button) => {
      button.addEventListener('click', () => setSelectedAvatar(button.dataset.avatarChoice));
    });

    document.querySelector('[data-avatar-confirm]').addEventListener('click', () => {
      showProfileScreen(profileReturnScreen || 'setup');
    });

    document.querySelector('[data-profile-setup-form]').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!event.currentTarget.reportValidity()) return;
      selectedProfileName = profileSetupName.value.trim() || 'Main profile';
      profileCreatedAvatar.src = selectedProfileAvatar;
      showProfileScreen('created');
    });

    profileSkipButton.addEventListener('click', () => {
      selectedProfileName = 'Main profile';
      selectedProfileAvatar = profileAvatarPath('01');
      profileCreatedAvatar.src = selectedProfileAvatar;
      showProfileScreen('created');
    });

    document.querySelector('[data-profile-edit-form]').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!event.currentTarget.reportValidity()) return;
      selectedProfileName = profileEditName.value.trim() || selectedProfileName;
      profileStatus.textContent = `${selectedProfileName} updated in the prototype.`;
      showProfileScreen('manage');
    });

    document.querySelector('[data-profile-delete]').addEventListener('click', () => {
      profileStatus.textContent = 'Prototype only — deletion would require a separate confirmation.';
    });

    document.querySelector('[data-profile-enter]').addEventListener('click', () => {
      profileArrivalName.textContent = selectedProfileName;
      showProfileScreen('arrival');
    });

    document.querySelector('[data-profile-restart]').addEventListener('click', openProfilePicker);

    setLSlide(0);
    if (requestedEmail) emailInput.value = requestedEmail;
    if (params.get('view') === 'profiles' || requestedProfile) {
      const directProfile = requestedProfile === 'add' ? 'setup' : (requestedProfile || 'chooser');
      if (directProfile === 'setup') showProfileScreen('setup', { mode: requestedProfile === 'add' ? 'add' : 'first', focus: false });
      else if (directProfile === 'avatars') showProfileScreen('avatars', { returnTo: params.get('returnTo') || 'setup', focus: false });
      else showProfileScreen(directProfile, { focus: false });
    } else if (params.get('view') === 'auth') {
      showLAuth();
      if (requestedStep === 'code' || requestedStep === 'verify') {
        showLCode({ focus: false, value: requestedStep === 'verify' && requestedOtp.length < 4 ? '2192' : requestedOtp, mode: requestedAccount });
        if (requestedStep === 'verify') startLVerification({ fixture: true });
      } else if (requestedStep === 'password') showLCredential();
    } else showLWelcome(false);
  }

  document.documentElement.dataset.prototypeVariant = variant;
})();
