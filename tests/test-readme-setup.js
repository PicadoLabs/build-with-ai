const assert = require('assert');
const { generateReadme } = require('../lib/export');

// Setup-instruction coverage for generateReadme (issue #196): the exported
// README must match the project runtime instead of always assuming Node.js.
// Wired into `npm test` via package.json; run standalone with
// `node tests/test-readme-setup.js`.

function readmeFor(state, decisions) {
  return generateReadme(state, { project: { name: state.projectName, idea: 'Test project.' }, decisions });
}

// Node stays the default and keeps the exact legacy Getting Started block.
const nodeReadme = readmeFor(
  { projectName: 'Expense Tracker', templateId: 'web-app', templateTitle: 'Web App' },
  { frontendStack: 'Next.js 14 + Tailwind CSS', backendStack: 'Node.js + Express', database: 'PostgreSQL with Prisma' }
);
assert(nodeReadme.includes('npm install'), 'Node projects keep npm setup');
assert(nodeReadme.includes('npm run dev'), 'Node projects keep npm run dev');
assert(!nodeReadme.includes('uvicorn'), 'Node README must not mention uvicorn');
assert(!nodeReadme.includes('flutter'), 'Node README must not mention flutter');
assert(
  nodeReadme.includes('### Prerequisites\n- Node.js (>= 18)\n- npm / pnpm / yarn'),
  'Node prerequisites block is unchanged'
);
const legacyBlock = [
  '## Getting Started',
  '### Prerequisites',
  '- Node.js (>= 18)',
  '- npm / pnpm / yarn',
  '',
  '### Installation & Setup',
  '```bash',
  '# Clone repository',
  'git clone <repo-url>',
  'cd Expense Tracker',
  '',
  '# Install dependencies',
  'npm install',
  '',
  '# Setup environment',
  'cp .env.example .env',
  '',
  '# Run development server',
  'npm run dev',
  '```'
].join('\n');
assert(nodeReadme.includes(legacyBlock), 'Node Getting Started block must be byte-identical to the old output');

// Python via template id (fastapi-backend.json carries id "fastapi-backend").
const pythonReadme = readmeFor(
  { projectName: 'Tasks API', templateId: 'fastapi-backend', templateTitle: 'Production FastAPI Backend' },
  { backendStack: 'Python + FastAPI', database: 'PostgreSQL' }
);
assert(pythonReadme.includes('python -m venv venv'), 'Python README needs venv setup');
assert(pythonReadme.includes('pip install -r requirements.txt'), 'Python README needs pip install');
assert(pythonReadme.includes('uvicorn main:app --reload'), 'Python README needs uvicorn run');
assert(!pythonReadme.includes('npm install'), 'Python README must not instruct npm install');

// Python via decisions only (no template id).
const pythonDecisions = readmeFor({ projectName: 'Tasks API' }, { backendStack: 'FastAPI', database: 'PostgreSQL' });
assert(pythonDecisions.includes('uvicorn main:app --reload'), 'Decisions-only FastAPI must use uvicorn');
assert(!pythonDecisions.includes('npm install'), 'Decisions-only FastAPI must not use npm');

// Flutter via template id.
const flutterReadme = readmeFor(
  { projectName: 'Shop App', templateId: 'flutter-app', templateTitle: 'Cross-Platform Mobile App (Flutter & Dart)' },
  { frontendStack: 'Flutter', database: 'Firebase' }
);
assert(flutterReadme.includes('flutter pub get'), 'Flutter README needs pub get');
assert(flutterReadme.includes('flutter run'), 'Flutter README needs flutter run');
assert(!flutterReadme.includes('npm install'), 'Flutter README must not instruct npm install');

// Flutter via decisions only (no template id).
const flutterDecisions = readmeFor({ projectName: 'Shop App' }, { frontendStack: 'Flutter' });
assert(flutterDecisions.includes('flutter pub get'), 'Decisions-only Flutter must use pub get');
assert(!flutterDecisions.includes('npm install'), 'Decisions-only Flutter must not use npm');

// The "Standard Web Stack" fallback text must not trip the Dart word-boundary check.
const standardReadme = readmeFor({ projectName: 'Plain' }, { frontendStack: 'Standard Web Stack' });
assert(standardReadme.includes('npm install'), 'Standard stack stays Node');

console.log('All README setup-instruction checks passed.');
