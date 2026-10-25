// Kept in a file (not inline) because the CSP allows only same-origin scripts.
document.getElementById('retry').addEventListener('click', () => location.reload());
window.addEventListener('online', () => location.reload());
