/**
 * Handy Andy TV Mounting - Custom Multi-Step Booking Widget
 * Built with 100% Inline Styles, Auto-Advance, & 2-Hour Slot Logic
 */
(function () {
  console.log('[ha-widget] Initializing inline-styled multi-step funnel...');

  const API_BASE = 'https://handy-andy-booking.vercel.app/api';
  const TARGET_ID = 'ha-widget';

  const steps = [
    { id: 'zip', label: 'Service Area', type: 'zip' },
    { id: 'size', label: 'TV Size', type: 'select', options: ['32" - 43"', '44" - 55"', '56" - 65"', '66" - 75"', '76" or Larger'] },
    { id: 'bracket', label: 'TV Bracket', type: 'select', options: ['I already have my own bracket', 'Provide a Fixed/Flush Bracket [+$45]', 'Provide a Tilt Bracket [+$55]', 'Provide a Full-Motion Articulating Bracket [+$95]'] },
    { id: 'fireplace', label: 'Is your TV over a fireplace?', type: 'select', options: ['No', 'Yes - Brick/Stone [+$35]', 'Yes - Drywall/Plaster [+$35]', 'Yes - Concrete/Other [+$35]'] },
    { id: 'wires', label: 'Wire Concealment', type: 'select', options: ['No, leave wires exposed', 'Yes, hide inside drywall [+$65]', 'Yes, conceal with external track [+$25]'] },
    { id: 'surface', label: 'What is the wall surface?', type: 'select', options: ['Drywall', 'Brick, Concrete, or Stone [+$35]', 'Metal Studs', 'Tile / Backsplash [+$60]'] },
    { id: 'lift', label: 'Did you want your TV installed above normal height?', description: 'For example hanging from the ceiling or very high on the wall.', type: 'select', options: ['No, standard height (Eye level while sitting)', 'Yes, High Mount'] },
    { id: 'dismount', label: 'Dismount Existing TV?', type: 'select', options: ['No, area is clear', 'Yes, take down an old TV first [+$35]'] },
    { id: 'extras', label: 'Optional Add-ons', type: 'checkbox', options: ['Mount a Soundbar [+$45]', 'Install LED Backlighting strip [+$45]', 'None'] },
    { id: 'terms', label: 'Terms & Conditions', type: 'terms' },
    { id: 'slots', label: 'Select Appointment Window', type: 'slots' },
    { id: 'customer', label: 'Contact Details', type: 'customer' }
  ];

  let currentStepIndex = 0;
  let bookingData = {
    zip: '', territory_id: '', timezone: '', answers: {}, selectedSlot: null,
    customer: { first_name: '', last_name: '', email: '', phone: '', address: '' }
  };
  let availableSlots = [];

  function shouldSkipStep(stepId, currentAnswers) {
    if (stepId === 'lift' && currentAnswers['size'] === '32" - 43"') return true;
    return false;
  }

  const S = {
    host: 'display:block!important; visibility:visible!important; position:relative!important; z-index:999999!important; background:#18181c!important; border:1px solid #2d2d34!important; border-radius:12px!important; padding:30px!important; box-shadow:0 10px 30px rgba(0,0,0,0.5)!important; font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif!important; box-sizing:border-box!important; color:#ffffff!important;',
    progressWrap: 'background:#2d2d34!important; height:6px!important; border-radius:3px!important; margin-bottom:20px!important; overflow:hidden!important; display:block!important;',
    progressBar: (pct) => `background:#ff6600!important; height:100%!important; width:${pct}%!important; display:block!important; transition: width 0.3s ease!important;`,
    stepLabel: 'color:#a0a0ab!important; font-size:13px!important; text-transform:uppercase!important; margin-bottom:8px!important; display:block!important; letter-spacing:1px!important;',
    h1Zip: 'margin:0 0 10px 0!important; font-size:32px!important; font-weight:800!important; color:#ffffff!important; display:block!important; text-align:center!important; line-height:1.2!important;',
    h2: 'margin:0 0 20px 0!important; font-size:24px!important; font-weight:700!important; color:#ffffff!important; display:block!important;',
    leadZip: 'color:#d4d4d8!important; margin-bottom:24px!important; line-height:1.5!important; display:block!important; font-size:16px!important; text-align:center!important;',
    lead: 'color:#d4d4d8!important; margin-bottom:24px!important; line-height:1.5!important; display:block!important; font-size:16px!important;',
    description: 'color:#a0a0ab!important; margin-top:-15px!important; margin-bottom:20px!important; font-size:14px!important; display:block!important;',
    input: 'width:100%!important; padding:16px!important; background:#27272a!important; border:1px solid #3f3f46!important; color:#ffffff!important; border-radius:8px!important; font-size:18px!important; box-sizing:border-box!important; margin-bottom:24px!important; display:block!important; text-align:center!important;',
    inputLeft: 'width:100%!important; padding:12px!important; background:#27272a!important; border:1px solid #3f3f46!important; color:#ffffff!important; border-radius:6px!important; font-size:16px!important; box-sizing:border-box!important; margin-bottom:20px!important; display:block!important;',
    btnPrimaryZip: 'background:#ff6600!important; color:#ffffff!important; border:none!important; padding:16px 32px!important; font-size:18px!important; font-weight:700!important; border-radius:8px!important; cursor:pointer!important; display:block!important; width:100%!important; text-align:center!important;',
    btnPrimary: 'background:#ff6600!important; color:#ffffff!important; border:none!important; padding:12px 24px!important; font-size:16px!important; font-weight:600!important; border-radius:6px!important; cursor:pointer!important; display:inline-block!important;',
    btnSecondary: 'background:transparent!important; color:#a0a0ab!important; border:1px solid #3f3f46!important; padding:12px 24px!important; font-size:16px!important; border-radius:6px!important; cursor:pointer!important; margin-right:12px!important; display:inline-block!important;',
    actions: 'display:flex!important; justify-content:space-between!important; margin-top:20px!important;',
    optionGroup: 'display:flex!important; flex-direction:column!important; gap:12px!important; margin-bottom:24px!important;',
    optionCard: (isSelected) => `background:${isSelected ? 'rgba(255,102,0,0.1)' : '#27272a'}!important; border:1px solid ${isSelected ? '#ff6600' : '#3f3f46'}!important; padding:16px!important; border-radius:8px!important; cursor:pointer!important; color:#ffffff!important; display:block!important; margin-bottom:12px!important; font-size:16px!important; font-weight:500!important; transition: all 0.2s ease!important;`,
    slotGrid: 'display:grid!important; grid-template-columns:1fr 1fr!important; gap:10px!important; max-height:300px!important; overflow-y:auto!important; margin-bottom:24px!important;'
  };

  function render() {
    const root = document.getElementById(TARGET_ID);
    if (!root) return;

    root.style.cssText = S.host;

    const currentStep = steps[currentStepIndex];
    const progressPercent = Math.round(((currentStepIndex + 1) / steps.length) * 100);

    let stepInterfaceHTML = '';

    if (currentStep.type === 'zip') {
      stepInterfaceHTML = `
        <h1 style="${S.h1Zip}">Book Your TV Mounting</h1>
        <p style="${S.leadZip}">Enter your zip code to confirm we service your area.</p>
        <input type="text" id="ha-zip" style="${S.input}" placeholder="e.g. 80203" maxlength="5" value="${bookingData.zip}">
        <button style="${S.btnPrimaryZip}" id="btn-next">Check Service Area</button>
      `;
    } else if (currentStep.type === 'select') {
      stepInterfaceHTML = `
        <h2 style="${S.h2}">${currentStep.label}</h2>
        ${currentStep.description ? `<p style="${S.description}">${currentStep.description}</p>` : ''}
        <div style="${S.optionGroup}">
          ${currentStep.options.map(opt => `
            <div class="ha-card-click" style="${S.optionCard(bookingData.answers[currentStep.id] === opt)}" data-value="${opt}">
              ${opt}
            </div>
          `).join('')}
        </div>
        <div style="${S.actions}">
          <button style="${S.btnSecondary}" id="btn-prev">Back</button>
          <span></span>
        </div>
      `;
    } else if (currentStep.type === 'checkbox') {
      stepInterfaceHTML = `
        <h2 style="${S.h2}">${currentStep.label}</h2>
        <div style="${S.optionGroup}">
          ${currentStep.options.map(opt => {
            const checked = (bookingData.answers[currentStep.id] || []).includes(opt);
            return `
              <div class="ha-chk-click" style="${S.optionCard(checked)}" data-checkbox-value="${opt}">
                ${opt}
              </div>
            `;
          }).join('')}
        </div>
        <div style="${S.actions}">
          <button style="${S.btnSecondary}" id="btn-prev">Back</button>
          <button style="${S.btnPrimary}" id="btn-next">Continue</button>
        </div>
      `;
    } else if (currentStep.type === 'terms') {
      stepInterfaceHTML = `
        <h2 style="${S.h2}">${currentStep.label}</h2>
        <p style="${S.lead}">By processing this request, you agree that your wall structure safely supports mounting setups and hidden hardware paths.</p>
        <div id="terms-agree" style="${S.optionCard(bookingData.answers.terms === 'accepted')}">
          I accept and understand the service policies.
        </div>
        <div style="${S.actions}">
          <button style="${S.btnSecondary}" id="btn-prev">Back</button>
          <button style="${S.btnPrimary}" id="btn-next" ${bookingData.answers.terms !== 'accepted' ? 'disabled' : ''}>Continue</button>
        </div>
      `;
    } else if (currentStep.type === 'slots') {
      stepInterfaceHTML = `
        <h2 style="${S.h2}">${currentStep.label}</h2>
        <div style="${S.slotGrid}">
          ${availableSlots.length === 0 ? `<p style="${S.lead}">Fetching available schedule slots...</p>` : availableSlots.map(slot => `
            <div class="ha-slot-click" style="${S.optionCard(bookingData.selectedSlot === slot.id)}" data-slot-id="${slot.id}">
              ${slot.formatted_date} <br> <span style="font-size:13px; color:#a0a0ab;">${slot.arrival_window}</span>
            </div>
          `).join('')}
        </div>
        <div style="${S.actions}">
          <button style="${S.btnSecondary}" id="btn-prev">Back</button>
          <button style="${S.btnPrimary}" id="btn-next" ${!bookingData.selectedSlot ? 'disabled' : ''}>Continue</button>
        </div>
      `;
    } else if (currentStep.type === 'customer') {
      stepInterfaceHTML = `
        <h2 style="${S.h2}">Your Information</h2>
        <input type="text" id="cust-fn" style="${S.inputLeft}" placeholder="First Name" value="${bookingData.customer.first_name}">
        <input type="text" id="cust-ln" style="${S.inputLeft}" placeholder="Last Name" value="${bookingData.customer.last_name}">
        <input type="email" id="cust-em" style="${S.inputLeft}" placeholder="Email Address" value="${bookingData.customer.email}">
        <input type="tel" id="cust-ph" style="${S.inputLeft}" placeholder="Phone Number" value="${bookingData.customer.phone}">
        <input type="text" id="cust-ad" style="${S.inputLeft}" placeholder="Street Address" value="${bookingData.customer.address}">
        <div style="${S.actions}">
          <button style="${S.btnSecondary}" id="btn-prev">Back</button>
          <button style="${S.btnPrimary}" id="btn-submit">Complete My Booking</button>
        </div>
      `;
    }

    const progressHTML = currentStep.type === 'zip' ? '' : `
      <div style="${S.progressWrap}">
        <div style="${S.progressBar(progressPercent)}"></div>
      </div>
      <div style="${S.stepLabel}">Step ${currentStepIndex + 1} of ${steps.length}: ${currentStep.label}</div>
    `;

    root.innerHTML = progressHTML + stepInterfaceHTML;
    bindEvents(root);
  }

  function bindEvents(root) {
    const nextBtn = root.querySelector('#btn-next');
    if (nextBtn) nextBtn.onclick = () => handleNext(root);

    const prevBtn = root.querySelector('#btn-prev');
    if (prevBtn) prevBtn.onclick = () => handleBack();

    const submitBtn = root.querySelector('#btn-submit');
    if (submitBtn) submitBtn.onclick = () => submitBooking(root);

    root.querySelectorAll('.ha-card-click').forEach(card => {
      card.onclick = () => {
        bookingData.answers[steps[currentStepIndex].id] = card.getAttribute('data-value');
        handleNext(root);
      };
    });

    root.querySelectorAll('.ha-chk-click').forEach(card => {
      card.onclick = () => {
        const stepId = steps[currentStepIndex].id;
        let selectedOpts = bookingData.answers[stepId] || [];
        const val = card.getAttribute('data-checkbox-value');
        if (selectedOpts.includes(val)) {
          selectedOpts = selectedOpts.filter(item => item !== val);
        } else {
          selectedOpts.push(val);
        }
        bookingData.answers[stepId] = selectedOpts;
        render();
      };
    });

    const termsBtn = root.querySelector('#terms-agree');
    if (termsBtn) {
      termsBtn.onclick = () => {
        bookingData.answers.terms = bookingData.answers.terms === 'accepted' ? '' : 'accepted';
        render();
      };
    }

    root.querySelectorAll('.ha-slot-click').forEach(card => {
      card.onclick = () => {
        bookingData.selectedSlot = card.getAttribute('data-slot-id');
        render();
      };
    });
  }

  async function handleNext(root) {
    const currentStep = steps[currentStepIndex];

    if (currentStep.type === 'zip') {
      const zipVal = root.querySelector('#ha-zip').value.trim();
      if (!zipVal) return alert('Please enter a zip code.');

      const originalBtnText = root.querySelector('#btn-next').innerText;
      root.querySelector('#btn-next').innerText = 'Checking...';

      try {
        const res = await fetch(`${API_BASE}/service-area`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ zip: zipVal })
        });
        const data = await res.json();
        if (!data.territory_id) {
          root.querySelector('#btn-next').innerText = originalBtnText;
          return alert('It appears this area is a little far for us. But you should call to confirm. 713-876-9032');
        }

        bookingData.zip = zipVal;
        bookingData.territory_id = data.territory_id;
        bookingData.timezone = data.timezone;
      } catch (err) {
        root.querySelector('#btn-next').innerText = originalBtnText;
        return alert('Network verification failed. Please try again.');
      }
    }

    if (currentStep.id === 'terms') fetchTimeslots();

    currentStepIndex++;
    while (currentStepIndex < steps.length && shouldSkipStep(steps[currentStepIndex].id, bookingData.answers)) {
      currentStepIndex++;
    }
    render();
  }

  function handleBack() {
    currentStepIndex--;
    while (currentStepIndex > 0 && shouldSkipStep(steps[currentStepIndex].id, bookingData.answers)) {
      currentStepIndex--;
    }
    render();
  }

  async function fetchTimeslots() {
    try {
      const res = await fetch(`${API_BASE}/slots?territory_id=${bookingData.territory_id}&duration=120`);
      const data = await res.json();
      availableSlots = data.slots || [];
      render();
    } catch (err) {
      console.error('Error getting slots:', err);
      availableSlots = [];
      render();
    }
  }

  async function submitBooking(root) {
    bookingData.customer.first_name = root.querySelector('#cust-fn').value.trim();
    bookingData.customer.last_name = root.querySelector('#cust-ln').value.trim();
    bookingData.customer.email = root.querySelector('#cust-em').value.trim();
    bookingData.customer.phone = root.querySelector('#cust-ph').value.trim();
    bookingData.customer.address = root.querySelector('#cust-ad').value.trim();

    try {
      const res = await fetch(`${API_BASE}/book`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingData)
      });

      if (res.ok) {
        root.innerHTML = `
          <div style="text-align: center; padding: 40px!important; display:block!important;">
            <h2 style="color: #ff6600!important; font-size: 28px!important; margin-bottom: 16px!important; font-weight: bold!important;">Booking Confirmed!</h2>
            <p style="${S.lead}">Your TV mounting job has been scheduled successfully. Check your email for summary details.</p>
          </div>
        `;
      } else {
        alert('Could not submit booking details. Please verify your contact form info.');
      }
    } catch (err) {
      alert('Error finalizing system booking.');
    }
  }

  function startWidget() {
    const root = document.getElementById(TARGET_ID);
    if (!root) {
      setTimeout(startWidget, 50);
      return;
    }
    render();
  }

  startWidget();
})();
