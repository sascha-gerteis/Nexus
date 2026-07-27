document.addEventListener("DOMContentLoaded", async function () {
  const navSlot = document.getElementById("buyerNavSlot");

  if (!navSlot) return;

  function showLoginButton() {
    navSlot.innerHTML = `
      <a class="btn btn-primary btn-small" href="/pages/buyer/login.html">
        Login
      </a>
    `;
  }

  function showDashboardButton() {
    navSlot.innerHTML = `
      <a class="btn btn-primary btn-small" href="/pages/buyer/dashboard.html">
        Dashboard
      </a>
    `;
  }

  if (typeof NexusDB === "undefined") {
    showLoginButton();
    return;
  }

  const { data, error } = await NexusDB.getUser();

  if (error || !data) {
    showLoginButton();
    return;
  }

  showDashboardButton();
});