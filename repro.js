// Reproduction harness: simulate the chat session's stdin setup (raw mode
// + a manual data listener for Ctrl+C) and then exercise the clarify read
// path (readLineInteractive) to see whether the process exits to shell.

const readline = require('readline');

// (A) Mimic chatHandoff's setup -----------------------------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'you > ',
});

// Simulate setActiveReadline(rl):
const userInput = require('./dist/src/tools/user_input');
userInput.setActiveReadline(rl);

const CTRL_C = '\u0003';
const onStdinData = (chunk) => {
  const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
  if (str.includes(CTRL_C)) {
    console.log('\n[handleInterrupt] Ctrl+C seen');
  }
};

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.on('data', onStdinData);

async function main() {
  console.log('Type your clarify answer below, then press Enter:');
  const answer = await userInput.readLineInteractive('  answer > ');
  console.log('\nGOT ANSWER:', JSON.stringify(answer));
  console.log('If you see this, clarify returned without exiting to shell.');
  // Clean up so the script ends instead of hanging on readline.
  rl.close();
  process.stdin.removeListener('data', onStdinData);
  process.stdin.setRawMode(false);
  process.exit(0);
}

main();
