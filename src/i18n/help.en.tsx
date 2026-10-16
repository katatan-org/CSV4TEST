/** English long-form help (see help.ja.tsx, the source). */
import type { HelpContent } from "./help";

export const helpEn: HelpContent = {
  shortcuts: [
    ["Ctrl+S", "Save"],
    ["Ctrl+Z / Ctrl+Y", "Undo / Redo"],
    ["Ctrl+F / Ctrl+H", "Find / Replace"],
    ["Enter / F2 / start typing", "Edit the cell"],
    ["Alt+Enter (while editing)", "New line in the cell"],
    ["Enter / Tab (while editing)", "Confirm and move down / right"],
    ["Esc (while editing)", "Cancel the edit"],
    ["{{ (while editing)", "Complete a variable name"],
    ["Ctrl+C / Ctrl+X / Ctrl+V", "Copy / Cut / Paste (works with Excel both ways)"],
    ["Delete", "Clear the selection"],
    ["Ctrl+D / Ctrl+R", "Fill down / right"],
    ["Fill handle", "Drag the bottom-right corner of the selection to copy it"],
    ["Ctrl+Shift++", "Insert a row below"],
    ["Ctrl+-", "Delete the selected rows"],
    ["Shift+click / Ctrl+click", "Select a range / several cells"],
    ["+ on row numbers and column headers", "Insert a row or column"],
    ["Drag a row number", "Move the row (not while sorted or filtered)"],
    ["Drag a column header", "Move the column"],
    ["Click case-N", "Jump to that case"],
    ["?", "This list of shortcuts"],
    ["F1", "Help (how things work)"],
  ],
  shortcutsNote:
    "The display (column widths, colors, numbering) is never written to the CSV. Saving rewrites only the rows you edited and keeps line endings, the BOM and quoting as they were.",
  guide: [
    {
      id: "overview",
      title: "About CSV4TEST",
      body: (
        <>
          <p>A tool to read test case CSVs kept in Git comfortably and edit them like a spreadsheet.</p>
          <ul>
            <li>
              <b>Nothing about the display is written to the CSV.</b> Column widths, colors, badges and step numbers exist only on screen.
            </li>
            <li>
              <b>Saving keeps the diff minimal.</b> Rows you did not edit are written back byte for byte, so git diff shows only the rows you edited.
            </li>
            <li>
              <b>Sorting and filtering affect only the view.</b> The order of rows in the file does not change.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "files",
      title: "Opening and saving",
      body: (
        <>
          <dl>
            <dt>Open folder (Chrome / Edge)</dt>
            <dd>
              Open the folder of a repository and pick a CSV in the tree on the left. Ctrl+S overwrites that file. Showing and adding images and .csvview.json work only when
              you open a folder this way.
            </dd>
            <dt>File / drag and drop</dt>
            <dd>Opens a single CSV. In Firefox / Safari, saving downloads the file (see "Browser differences").</dd>
            <dt>Sample</dt>
            <dd>Read-only. Saving downloads a copy.</dd>
          </dl>
          <p>
            If the file changes while it is open (<code>git pull</code>, <code>git checkout</code>), it is reloaded automatically (Chrome / Edge only). If you have
            unsaved changes, you are asked first.
          </p>
          <p>The encoding (UTF-8 / Shift_JIS), BOM, line endings (CRLF / LF, also inside cells), quoting and the final line ending are saved as they were read.</p>
        </>
      ),
    },
    {
      id: "browsers",
      title: "Browser differences",
      body: (
        <>
          <p>
            Saving in place and reading or writing images use a browser feature that works with files on your computer directly (the File System Access API). Only
            Chromium-based browsers such as Chrome and Edge support it. Even there, some features are unavailable when you open a single CSV, because the files next to it
            cannot be read.
          </p>
          <table className="guide-matrix">
            <thead>
              <tr>
                <th />
                <th>
                  Chrome / Edge
                  <br />
                  <small>Open folder</small>
                </th>
                <th>
                  Chrome / Edge
                  <br />
                  <small>Open one file</small>
                </th>
                <th>
                  Firefox / Safari
                  <br />
                  <small>Open one file</small>
                </th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["View, edit, validate and review changes", "○", "○", "○"],
                  ["Saving with Ctrl+S", "Overwrite", "Overwrite", "Download"],
                  ["Reload on outside changes (git pull, etc.)", "○", "○", "×"],
                  ["Pick a CSV from the folder tree", "○", "×", "×"],
                  ["Show images by relative path", "○", "×", "×"],
                  ["Add images (paste, drop, button)", "○", "×", "×"],
                  ["Show images by URL (https://…)", "○", "○", "○"],
                  ["Read .csvview.json", "○", "×", "×"],
                ] as const
              ).map(([feature, ...cells]) => (
                <tr key={feature}>
                  <th>{feature}</th>
                  {cells.map((c, i) => (
                    <td key={i} className={c === "×" ? "no" : c === "○" ? "yes" : undefined}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <ul>
            <li>In Chrome / Edge, dropping a folder onto the window is the same as "Open folder".</li>
            <li>Brave is Chromium-based but turns this feature off by default.</li>
            <li>
              The feature works only on pages served from <code>localhost</code> or over https. Serve the app over https when you host it, for example on an internal server.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "editing",
      title: "Editing",
      body: (
        <>
          <dl>
            <dt>Editing cells</dt>
            <dd>Select a cell and start typing, or press Enter / F2. Alt+Enter adds a line break in the cell; Esc cancels.</dd>
            <dt>Adding rows</dt>
            <dd>
              Type into any blank cell below the last row. Rows left empty in between are saved as empty rows with only delimiters (e.g. <code>,,,,</code>). Clearing a blank
              cell does not add rows.
            </dd>
            <dt>Inserting rows and columns</dt>
            <dd>
              Hover a row number for <b>+</b> buttons on its top and bottom borders, or a column header for buttons on its left and right borders. The context menu and the
              column header menu can insert and delete too.
            </dd>
            <dt>Selecting and moving rows</dt>
            <dd>Click a row number to select the row; drag it to move the row (not while sorted or filtered). Drag a column header to move the column.</dd>
            <dt>Working with Excel</dt>
            <dd>Copy and paste ranges with Ctrl+C / Ctrl+V; line breaks inside cells are kept. Pasting one value onto a range fills the whole range.</dd>
            <dt>Undo</dt>
            <dd>Ctrl+Z / Ctrl+Y undo and redo any operation.</dd>
          </dl>
        </>
      ),
    },
    {
      id: "view",
      title: "Sorting and filtering",
      body: (
        <>
          <p>Both affect only the view; the order of rows in the file does not change.</p>
          <dl>
            <dt>Sorting</dt>
            <dd>
              Choose it from the column header menu. The order from the moment you sorted is kept, so rows do not jump around while you edit. Rows added after sorting are shown
              at the end.
            </dd>
            <dt>Filtering</dt>
            <dd>
              "Filter rows" in the toolbar searches every column. The column header menu filters one column, and the Labels and Variables tabs of the side panel show only the
              rows with a label or a variable.
            </dd>
          </dl>
          <p>While filtering, the blank rows below the last row are hidden (so a row you type does not disappear at once because it does not match).</p>
        </>
      ),
    },
    {
      id: "rules",
      title: "Display rules and detection",
      body: (
        <>
          <p>
            The display rules are chosen from the headers of the CSV. If the headers include <code>No, Test Subject, Preconditions, Steps, Expected Result, Notes</code>, the
            file is shown in the <b>KATATAN format</b>; otherwise as a <b>generic CSV</b>. You can switch the rules in the Display rules tab of the side panel.
          </p>
          <h4>Columns of a generic CSV</h4>
          <p>The display of each column is decided from the values in its first 300 rows.</p>
          <table>
            <tbody>
              <tr>
                <th>90% or more numbers</th>
                <td>Right-aligned, monospace</td>
              </tr>
              <tr>
                <th>90% or more dates</th>
                <td>Monospace</td>
              </tr>
              <tr>
                <th>90% or more URLs</th>
                <td>Highlighted as links, wrapped</td>
              </tr>
              <tr>
                <th>Few distinct values</th>
                <td>
                  Color-coded <b>badges</b> (at least 4 non-empty values, at most 8 distinct values that repeat, each 24 characters or less without line breaks)
                </td>
              </tr>
              <tr>
                <th>Multiple lines, long text</th>
                <td>Wrapped</td>
              </tr>
            </tbody>
          </table>
          <div className="guide-callout">
            <b>If the display suddenly changes</b>
            <p>
              Detection runs again <b>when a file is opened, when a header changes and when a column is added or removed</b>, not on every edit. So if you add a column after
              entering values, the columns are detected again from the current data and one may suddenly show badges. The CSV itself does not change.
            </p>
            <p>
              To fix the display, set rules per column in <code>.csvview.json</code> (see "Customizing").
            </p>
          </div>
        </>
      ),
    },
    {
      id: "katatan",
      title: "KATATAN format",
      body: (
        <>
          <table>
            <tbody>
              <tr>
                <th>No</th>
                <td>
                  Shown as <code>case-N</code> and pinned to the left (the data stays a number). Inserted rows get the next number automatically.
                </td>
              </tr>
              <tr>
                <th>Labels (optional)</th>
                <td>One label per line in the cell. Shown as badges; you can filter by label.</td>
              </tr>
              <tr>
                <th>Steps</th>
                <td>Each line is a step and is shown numbered (the numbers are not written to the data).</td>
              </tr>
              <tr>
                <th>Expected Result</th>
                <td>Shown on a light green background.</td>
              </tr>
              <tr>
                <th>Images (optional)</th>
                <td>
                  One path per line, relative to the CSV. "Add image", drag and drop or pasting a screenshot saves it under <code>&lt;CSV name&gt;.assets/</code> and adds the
                  path (only when a folder is opened in Chrome / Edge).
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            <code>{"{{variable}}"}</code>, <code>{"'input'"}</code> and <code>{"{parameter}"}</code> are highlighted, and clicking <code>case-N</code> jumps to that case.
            Typing <code>{"{{"}</code> while editing completes the variable names in use.
          </p>
          <p>If the Labels or Images column is missing, buttons in the toolbar add it. When you open an empty file, you can create a KATATAN header.</p>
        </>
      ),
    },
    {
      id: "panel",
      title: "Side panel",
      body: (
        <dl>
          <dt>Issues</dt>
          <dd>
            Warns about duplicate No values, references to missing case-N, unclosed {"{{"}, missing images and images no row refers to. Click one to go to the cell.
          </dd>
          <dt>Changes</dt>
          <dd>Shows the unsaved changes by row and cell.</dd>
          <dt>Variables</dt>
          <dd>The {"{{variables}}"} in use. Click one to show only the rows that use it.</dd>
          <dt>Labels</dt>
          <dd>The labels in use. Shows only the rows with the chosen labels (any of them, when several are chosen).</dd>
          <dt>Display rules</dt>
          <dd>The rules in use and how each column is displayed.</dd>
        </dl>
      ),
    },
    {
      id: "custom",
      title: "Customizing",
      body: (
        <>
          <p>
            Put a <code>.csvview.json</code> file in the folder of the CSV (or a parent folder) to override the width, colors and display of each column. The file closest to
            the CSV is used.
          </p>
          <pre>{`{
  "extends": "generic",
  "columns": [
    { "match": "index" },
    { "match": "result", "badge": { "ok": "green", "ng": "red", "skip": "gray" } },
    { "match": "Steps", "width": 520 }
  ]
}`}</pre>
          <p>
            <code>match</code> is a column name (case and spaces are ignored) or a <code>/regular expression/</code>. Columns with rules are left out of detection, so their
            display stays fixed. See the README for every option.
          </p>
        </>
      ),
    },
  ],
  welcomePoints: [
    <>
      Detects the <strong>KATATAN format</strong>, numbers the steps and highlights <code>{"{{variables}}"}</code>, <code>'inputs'</code> and <code>case-N</code>
    </>,
    <>Select ranges, copy and paste, fill and undo as in Excel. Copying to and from Excel keeps line breaks inside cells</>,
    <>Line endings (CRLF/LF), the BOM, quoting and the encoding are saved as they were</>,
  ],
};
