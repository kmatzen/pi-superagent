// The engine reads PI_SUPERAGENT_* from the shell; inheriting them makes the suite test a live engine.
const keys = Object.keys(process.env).filter(k => k.startsWith('PI_SUPERAGENT_'))
for (const k of keys) delete process.env[k]
