Ah, yes — you mean **all the possible ways the exact phrase**

> `What does @index.js do?`

can be written/parsed in your CLI, and what each one actually becomes.

Based on your `parseQuestion()` implementation, there are several important combinations.

### 1. `@index.js` attached to the question

```text
askweb "What does @index.js do?"
```

Your parser splits the quoted argument on whitespace:

```text
What
does
@index.js
do?
```

Then:

```text
What        → question
does        → question
@index.js   → FILE
do?         → question
```

Result:

```js
{
  text: "What does do?",
  files: ["index.js"]
}
```

So **the `@index.js` disappears from the actual question**. This is explicitly how the current parser behaves: `@...` is pushed into `fileRefs`, not `textParts`. 

---

## All the useful combinations

Assuming `index.js` exists:

| Command                               | Question text sent | File detected? |
| ------------------------------------- | ------------------ | -------------- |
| `askweb "What does @index.js do?"`    | `What does do?`    | ✅ `index.js`   |
| `askweb "What does" @index.js "do?"`  | `What does do?`    | ✅ `index.js`   |
| `askweb "What does" index.js "do?"`   | `What does do?`    | ✅ `index.js`   |
| `askweb "What does index.js do?"`     | `What does do?`    | ✅ `index.js`   |
| `askweb "What does" "index.js" "do?"` | `What does do?`    | ✅ `index.js`   |
| `askweb "What does" @index.js`        | `What does`        | ✅ `index.js`   |
| `askweb @index.js "What does it do?"` | `What does it do?` | ✅ `index.js`   |
| `askweb index.js "What does it do?"`  | `What does it do?` | ✅ `index.js`   |

The key thing is that **both `index.js` and `@index.js` become file references when they are separate tokens**. The difference is that bare `index.js` is recognized only if it exists, while `@index.js` is explicitly treated as a file reference.  

---

# But there is an important distinction

These two:

```bash
askweb "What does @index.js do?"
```

and:

```bash
askweb @index.js "What does it do?"
```

**look conceptually similar to a human**, but your program treats them differently at the prompt level.

### A

```bash
askweb "What does @index.js do?"
```

becomes:

```text
Question:
What does do?

File:
index.js
```

### B

```bash
askweb @index.js "What does it do?"
```

becomes:

```text
Question:
What does it do?

File:
index.js
```

**B is actually better with your current implementation.**

Because the question still says what you want to know.

---

# The combinations with `node`

Exactly the same parsing happens with:

```bash
node index.js "What does @index.js do?"
```

or:

```bash
node index.js @index.js "What does it do?"
```

The command name doesn't matter. Once execution reaches `parseQuestion()`, the arguments are processed the same way.

---

# The combinations with `npm run`

If your npm script is something like:

```json
"ask": "node index.js"
```

then:

```bash
npm run ask -- "What does @index.js do?"
```

and:

```bash
npm run ask -- @index.js "What does it do?"
```

behave the same as their `askweb`/`node` equivalents.

The `--` is npm's separator; everything after it becomes arguments to `index.js`.

---

# Multiple files

You can also do:

```bash
askweb @index.js @package.json "What do these files do?"
```

Result:

```js
{
  text: "What do these files do?",
  files: [
    "index.js",
    "package.json"
  ]
}
```

This is probably the **cleanest current syntax** for your CLI when you want to explicitly identify files.

Similarly:

```bash
askweb index.js package.json "What do these files do?"
```

will work if both files exist.

---

# Multiple `@` references inside the sentence

You can technically do:

```bash
askweb "Compare @index.js with @package.json"
```

Your parser produces:

```js
{
  text: "Compare with",
  files: [
    "index.js",
    "package.json"
  ]
}
```

That's the major weakness of the current implementation.

The files are recognized, but **their names disappear from the question**. This matches the behavior described in your attached reference. 

---

# So if your intended UX is this

You probably want:

```bash
askweb "What does @index.js do?"
```

to mean:

```text
Question:
What does @index.js do?

Files:
index.js
```

rather than your current behavior:

```text
Question:
What does do?

Files:
index.js
```

And:

```bash
askweb "Compare @index.js with @package.json"
```

should ideally become:

```text
Question:
Compare @index.js with @package.json

Files:
index.js
package.json
```

That would make `@file` behave like a **real inline file reference**, which is probably what you're actually trying to achieve.

### In short

Your current syntax has two good forms:

```bash
askweb @index.js "What does it do?"
```

**Best with your current code.**

And the more natural syntax you probably *want*:

```bash
askweb "What does @index.js do?"
```

**Currently works for attaching the file, but incorrectly removes `@index.js` from the question.**
