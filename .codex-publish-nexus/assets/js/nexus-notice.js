(function () {
  function ensureNoticeModal() {
    let modal = document.getElementById("nexusGlobalNoticeModal");

    if (modal) return modal;

    modal = document.createElement("div");
    modal.className = "nexus-modal-lite";
    modal.id = "nexusGlobalNoticeModal";
    modal.setAttribute("aria-hidden", "true");

    modal.innerHTML = `
      <div class="nexus-modal-lite-backdrop" data-nexus-notice-close></div>

      <div class="nexus-modal-lite-card nexus-global-notice-card" role="dialog" aria-modal="true" aria-labelledby="nexusGlobalNoticeTitle">
        <button class="nexus-modal-lite-close" type="button" data-nexus-notice-close>×</button>

        <span class="eyebrow" id="nexusGlobalNoticeEyebrow">Update</span>

        <h2 id="nexusGlobalNoticeTitle">Update</h2>

        <p id="nexusGlobalNoticeMessage">
          Something happened.
        </p>

        <div class="nexus-global-notice-extra" id="nexusGlobalNoticeExtra" style="display:none"></div>

        <div class="modal-lite-actions">
          <button class="btn btn-primary" type="button" data-nexus-notice-close>
            Done
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    const closeButton = modal.querySelector(".nexus-modal-lite-close");
    if (closeButton) {
      closeButton.setAttribute("aria-label", "Close notification");
      closeButton.innerHTML = "&times;";
    }

    modal.querySelectorAll("[data-nexus-notice-close]").forEach((button) => {
      button.addEventListener("click", close);
    });

    return modal;
  }

  function open(options) {
    const modal = ensureNoticeModal();

    const type = options?.type || "info";
    const title = options?.title || "Update";
    const message = options?.message || "";
    const extra = options?.extra || "";

    const eyebrow = document.getElementById("nexusGlobalNoticeEyebrow");
    const titleEl = document.getElementById("nexusGlobalNoticeTitle");
    const messageEl = document.getElementById("nexusGlobalNoticeMessage");
    const extraEl = document.getElementById("nexusGlobalNoticeExtra");

    if (eyebrow) {
      if (type === "error") eyebrow.textContent = "Error";
      else if (type === "success") eyebrow.textContent = "Success";
      else if (type === "warning") eyebrow.textContent = "Important";
      else eyebrow.textContent = "Update";
    }

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    if (extraEl) {
      if (extra) {
        extraEl.style.display = "";
        extraEl.textContent = extra;
      } else {
        extraEl.style.display = "none";
        extraEl.textContent = "";
      }
    }

    modal.classList.remove("success", "error", "warning", "info");
    modal.classList.add(type);
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("nexus-notice-open");
  }

  function close() {
    const modal = document.getElementById("nexusGlobalNoticeModal");
    if (!modal) return;

    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("nexus-notice-open");
  }

  function success(title, message, extra) {
    open({ type: "success", title, message, extra });
  }

  function error(title, message, extra) {
    open({ type: "error", title, message, extra });
  }

  function warning(title, message, extra) {
    open({ type: "warning", title, message, extra });
  }

  function info(title, message, extra) {
    open({ type: "info", title, message, extra });
  }

  window.NexusNotice = {
    open,
    close,
    success,
    error,
    warning,
    info
  };
})();
