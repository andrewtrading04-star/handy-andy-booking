// Handy Andy — thank-you page display patches
// Add to page <head>: <script src="https://handy-andy-booking.vercel.app/thankyou-patch.js"></script>
document.addEventListener('DOMContentLoaded', function() {
  // "Estimated total" → "Total" (rename the label)
  var lbl = document.querySelector('#ha-ty .total .tl');
  if (lbl) lbl.textContent = 'Total';

  // Rename lifting line items → "Second Technician"
  document.querySelectorAll('#ha-ty .lineitem .nm').forEach(function(el) {
    var t = el.textContent || '';
    if (t === 'My TV is 85 inches or larger' ||
        t.indexOf('I cannot help lift') !== -1) {
      el.textContent = 'Second Technician';
    }
  });
});
