const status = document.querySelector("#script-status");

if (status instanceof HTMLElement) {
  status.textContent = "Browser preview: the nested script loaded successfully.";
}
