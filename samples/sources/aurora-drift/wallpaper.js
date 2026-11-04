const canvas = document.getElementById('stage');
const context = canvas.getContext('2d');

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

function frame(time) {
  const { width, height } = canvas;
  const seconds = time / 1000;

  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#0a0e28');
  sky.addColorStop(1, '#0c2c46');
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  context.globalCompositeOperation = 'lighter';
  for (let index = 0; index < 3; index += 1) {
    const baseline = height * (0.3 + index * 0.15);
    context.beginPath();
    context.moveTo(0, height);
    for (let x = 0; x <= width; x += 12) {
      const y = baseline + Math.sin(x * 0.003 + seconds * 0.25 + index * 1.7) * height * 0.08 + Math.sin(x * 0.009 + seconds * 0.4) * height * 0.02;
      context.lineTo(x, y);
    }
    context.lineTo(width, height);
    context.closePath();
    context.fillStyle = `rgba(90, 230, 190, ${0.08 - index * 0.015})`;
    context.fill();
  }
  context.globalCompositeOperation = 'source-over';

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
