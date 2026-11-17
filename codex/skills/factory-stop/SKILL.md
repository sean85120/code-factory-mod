---
name: factory-stop
description: "code-factory command, typed by the person as $factory-stop: stop the loop after the current turn. The code-factory hook runs it; never invoke it yourself."
---
This is a code-factory command. The code-factory hook runs it when the person types `$factory-stop`: it either answers the person directly, so the prompt never reaches you, or it adds the factory's instructions for this turn to your context, and you follow them exactly.

If no code-factory instructions or reply are in your context, the hook is not running. Do not try to do the command's work yourself, and do not edit anything under `.factory/` for it. Tell the person to open `/hooks`, trust the code-factory hooks (they need Node.js 22.6 or newer on PATH), and type `$factory-stop` again.
