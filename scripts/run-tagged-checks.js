'use strict';

const { run } = require('./run-check-suite');
const { TAGS, normalizeTags, commandsForTags } = require('./check-manifest');

function requestedTags(argv = process.argv.slice(2)) {
  const values = [];
  for (const arg of argv) {
    if (arg.startsWith('--tag=')) values.push(arg.slice('--tag='.length));
    else if (!arg.startsWith('--')) values.push(arg);
  }
  return normalizeTags(values);
}

async function main() {
  if (process.argv.includes('--list')) {
    for (const [tag, suites] of Object.entries(TAGS)) {
      console.log(`${tag}: ${suites.join(', ')}`);
    }
    return;
  }
  const tags = requestedTags();
  const commands = commandsForTags(tags);
  console.log(`check tags=${tags.join(',')}; running ${commands.length} unique commands`);
  for (let index = 0; index < commands.length; index += 1) {
    await run(commands[index], index + 1, commands.length);
  }
}

module.exports = { requestedTags };

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}
