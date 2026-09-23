# Additional permission: the export is yours

Animo is licensed under the GNU Affero General Public License, version 3 or
later (see [LICENSE](LICENSE)). This file grants an additional permission under
section 7 of that licence.

## What is excepted

1. **`src/runtime/animo-pixi.js`**, the runtime extension module. The exporter
   copies this file, byte for byte, into every export, and it then ships inside
   the games people make with Animo. It is licensed under the **MIT licence**:

   ```
   MIT License

   Copyright (c) 2026 Moreno Tomasella / Morenoise

   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software and associated documentation files (the "Software"), to deal
   in the Software without restriction, including without limitation the rights
   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is
   furnished to do so, subject to the following conditions:

   The above copyright notice and this permission notice shall be included in all
   copies or substantial portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   SOFTWARE.
   ```

2. **Everything Animo exports.** The skeleton JSON, the texture atlas JSON and
   PNGs, the extension manifest `<name>_ext.json`, the generated `README.md` and
   the runtime file placed beside them are **your output**. Animo claims no
   copyright in them, and running Animo does not make your project a derivative
   work of Animo.

3. **Project files** (`.animo`) and any artwork you import or produce are yours,
   unconditionally.

## What is not excepted

Everything else in this repository, the editor itself, is AGPL-3.0-or-later.
If you modify Animo and let other people use your modified version, including
over a network, you must offer them the corresponding source.

## Why

The AGPL is here to keep the *editor* open, not to reach into the games made
with it. Without this exception, section 5 would arguably make every game that
ships an Animo export a combined work, which is not the intent and would make
the tool unusable. This is the same reasoning behind the GCC Runtime Library
Exception.

## Commercial licensing

If the AGPL does not fit your organisation, a commercial licence for the editor
is available. Contact <info@morenoise.it>.
