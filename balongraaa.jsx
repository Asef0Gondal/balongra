/*
Expression Manager for After Effects
A compact ScriptUI Panel to store and apply expressions
*/

(function (thisObj) {

    // Global variables
    var scriptName = "Balongra AI agent";
    var expressionLibrary = [];
    var scriptLibrary = []; // Array to hold raw scripts
    var filteredIndices = [];
    var isEditMode = false;
    var editingIndex = -1;
    var currentGroupFilter = "All Groups";
    var currentSortMode = "Most Used";
    var currentTagFilter = "All";
    var actionHistory = [];
    var uiState = {
        lastTab: "expr",
        lastGroupFilter: "All Groups",
        lastSearchQuery: "",
        lastSortMode: "Most Used",
        lastTagFilter: "All",
        expressionEditorOpen: false,
        scriptEditorOpen: false,
        selectedModel: "ChatGPT",
        agentPlanPreviewEnabled: true,
        // agentAutoRepairEnabled removed — auto-repair disabled (compounds AE keyframe damage)
        agentPersistentLoggingEnabled: true,
        agentFathersMoneyModeEnabled: false,
        agentSkillMotionEnabled: true,
        agentSkillVisualEnabled: true,
        agentSkillTypographyEnabled: true,
        agentSkillDesignPrinciplesEnabled: true,
        agentSkillCompositingEnabled: true,
        agentSkillExpressionsEnabled: true,
        agentSkillSpatial3DEnabled: true,
        agentSkillAnimation12Enabled: true,
        agentSkillColorTheoryEnabled: true
    };
    var lastAgentRunArtifact = null;

    function ensureSettingsFolder() {
        try {
            var settingsFolder = new Folder(Folder.userData.fullName + "/ExpressoSettings");
            if (!settingsFolder.exists) settingsFolder.create();
            return settingsFolder;
        } catch (e) {
            return null;
        }
    }

    function appendRuntimeLog(tag, message) {
        if (uiState.agentPersistentLoggingEnabled === false) return;
        try {
            var folder = ensureSettingsFolder();
            if (!folder) return;
            var logFile = new File(folder.fullName + "/Balongra_Runtime.log");
            var maxLogBytes = 2 * 1024 * 1024;   // rotate at ~2MB
            var keepTailChars = 900000;          // keep recent portion

            if (logFile.exists && logFile.length > maxLogBytes) {
                try {
                    logFile.encoding = "UTF-8";
                    if (logFile.open("r")) {
                        var old = logFile.read();
                        logFile.close();
                        if (old.length > keepTailChars) old = old.substring(old.length - keepTailChars);
                        if (logFile.open("w")) {
                            logFile.write(old);
                            logFile.close();
                        }
                    }
                } catch (rotErr) { }
            }

            logFile.encoding = "UTF-8";
            if (!logFile.open("a")) return;
            var ts = new Date();
            var stamp = ts.getFullYear() + "-" +
                ("0" + (ts.getMonth() + 1)).slice(-2) + "-" +
                ("0" + ts.getDate()).slice(-2) + " " +
                ("0" + ts.getHours()).slice(-2) + ":" +
                ("0" + ts.getMinutes()).slice(-2) + ":" +
                ("0" + ts.getSeconds()).slice(-2);
            logFile.writeln("[" + stamp + "][" + (tag || "INFO") + "] " + (message || ""));
            logFile.close();
        } catch (e) { }
    }

    // API Settings
    var apiSettings = {
        openAIKey: "",
        anthropicKey: "",
        geminiKey: "",
        kimiKey: "",
        openRouterKey: "",
        groqKey: "",
        cerebrasKey: "",
        nimKey: "",
        githubKey: "",
        mistralKey: "",
        customApiKey: "",
        customEndpointUrl: "http://localhost:1234/v1/chat/completions",
        customModel: "local-model",
        activeModel: "ChatGPT"
    };

    // UI Panels references
    var tabs = {};

    // Default expressions - Massive Library of 260 Pro, SaaS & Tech Expressions
    var defaultExpressions = [];
    try {
        var scriptFolder = (new File($.fileName)).parent;
        var expFile = new File(scriptFolder.fsName + "/balongra_expressions.json");
        if (expFile.exists) {
            expFile.encoding = "UTF-8";
            expFile.open("r");
            var jsonStr = expFile.read();
            expFile.close();
            // Use JSON.parse instead of eval() — safer against tampered/malformed files
            // and consistent with the save/load system which already requires JSON support.
            if (typeof JSON !== "undefined") {
                defaultExpressions = JSON.parse(jsonStr);
            } else {
                // Fallback for AE versions predating native JSON (pre-CS6 era)
                defaultExpressions = eval("(" + jsonStr + ")");
            }
            if (!(defaultExpressions instanceof Array)) defaultExpressions = [];
        }
    } catch(e) {
        alert("Balongra Error loading expressions:\n" + e.toString());
        defaultExpressions = [];
    }

    // Auto-categorize default expressions based on keywords if they lack a group
    var availableGroups = ["All Groups", "★ Favorites", "UI & Animation", "Text & Counters", "Time & Looping", "3D, Math & Physics", "Utility & Workflow", "Lights & Shadows", "AI Generated"];
    for (var i = 0; i < defaultExpressions.length; i++) {
        var expr = defaultExpressions[i];
        if (!expr.group) {
            var n = expr.name.toLowerCase(); var e = expr.expression.toLowerCase(); var t = expr.targetProperty ? expr.targetProperty.toLowerCase() : "";
            if (n.indexOf("bounce") > -1 || n.indexOf("elastic") > -1 || n.indexOf("pop") > -1 || n.indexOf("ui") > -1 || n.indexOf("scale") > -1) expr.group = "UI & Animation";
            else if (n.indexOf("time") > -1 || n.indexOf("loop") > -1 || n.indexOf("delay") > -1 || n.indexOf("posterize") > -1) expr.group = "Time & Looping";
            else if (n.indexOf("text") > -1 || n.indexOf("counter") > -1 || n.indexOf("typewriter") > -1 || t.indexOf("source text") > -1) expr.group = "Text & Counters";
            else if (n.indexOf("3d") > -1 || n.indexOf("parallax") > -1 || n.indexOf("physics") > -1 || n.indexOf("math") > -1 || n.indexOf("sine") > -1) expr.group = "3D, Math & Physics";
            else expr.group = "Utility & Workflow";
        }
    }

    // ==========================================
    // AI HELPER FUNCTIONS
    // ==========================================

    // Valid target properties for expressions (matches the dropdown)
    var validTargetProperties = ["Position", "Rotation", "Scale", "Opacity", "Anchor Point", "Time Remap", "Effects (Custom)", "Source Text", "Path", "Stroke Width", "Color", "Any Property (Manual)"];

    // Build the system prompt — MAXIMUM FIDELITY version
    function buildAISystemPrompt(userDescription) {
        var systemRules = [
            "You are a specialized After Effects expression compiler. You receive a",
            "description of an animation behavior and return a single raw JSON object",
            "containing a working After Effects expression in ExtendScript (ES3).",
            "You are not conversational. You do not explain yourself.",
            "Your entire output is always and only a JSON object starting with { and",
            "ending with }. Nothing before it. Nothing after it.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 1 — OUTPUT FORMAT (ABSOLUTE)",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "Response is exactly one JSON object with these four keys:",
            "  \"name\"           — string",
            "  \"expression\"     — string",
            "  \"description\"    — string",
            "  \"targetProperty\" — string",
            "",
            "WRONG — markdown fences:       ```json { \"name\": \"...\" } ```",
            "WRONG — text before JSON:      Here is the expression: { \"name\": \"...\" }",
            "WRONG — text after JSON:       { \"name\": \"...\" } Let me know if you need changes!",
            "WRONG — multiple objects:      { \"name\": \"A\" } { \"name\": \"B\" }",
            "WRONG — single-quote JSON:     { 'name': '...' }",
            "WRONG — trailing comma:        { \"name\": \"Wiggle\", \"expression\": \"wiggle(2,20)\", }",
            "RIGHT:                         { \"name\": \"...\", \"expression\": \"...\", \"description\": \"...\", \"targetProperty\": \"...\" }",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 2 — STRING ENCODING IN THE \"expression\" FIELD",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "The expression is a single JSON string. Apply these encoding rules:",
            "",
            "2A — LINE BREAKS: Use \\n — never actual newlines inside the JSON string.",
            "  WRONG: \"amp = 30;          RIGHT: \"amp = 30;\\nfreq = 2;\"",
            "          freq = 2;\"",
            "",
            "2B — DOUBLE QUOTES: All \" inside the expression must be escaped as \\\"",
            "  WRONG: \"thisComp.layer(\\\"Target\\\")\"",
            "  RIGHT: \"thisComp.layer(\\\\\\\"Target\\\\\\\")\"",
            "",
            "2C — BACKSLASHES: All \\ inside the expression must be escaped as \\\\",
            "  WRONG: \"text.replace(/\\r/g, \\\" \\\")\"",
            "  RIGHT: \"text.replace(/\\\\r/g, \\\" \\\")\"",
            "",
            "2D — SOURCE TEXT LINE BREAKS: AE uses \\r for line breaks inside text output.",
            "  In JSON that means writing \\\\r inside the expression string.",
            "  RIGHT: \"str += \\\"\\\\r\\\";\"",
            "",
            "2E — REGEX: Backslashes in regex patterns must be double-escaped.",
            "  WRONG: \".replace(/\\B(?=(\\d{3})+(?!\\d))/g, \\\",\\\")\"",
            "  RIGHT: \".replace(/\\\\B(?=(\\\\d{3})+(?!\\\\d))/g, \\\",\\\")\"",
            "",
            "2F — NO TABS: Use spaces for indentation. Never actual tab characters.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 3 — EXTENDSCRIPT (ES3) LANGUAGE RULES",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "AE uses ExtendScript (JavaScript ES3, 1999). Many modern features do not",
            "exist and will throw a fatal error.",
            "",
            "━━ 3A — FORBIDDEN SYNTAX ━━",
            "",
            "FORBIDDEN (will break in AE — never use any of these):",
            "  let, const, =>, `template literals`, [...spread], {destructuring},",
            "  for...of, for...in on arrays,",
            "  Array: .forEach .map .filter .reduce .find .some .every .includes .flat .flatMap,",
            "  Object: Object.keys Object.values Object.entries Object.assign,",
            "  String: .startsWith .endsWith .includes .repeat .padStart .padEnd,",
            "  Number: Number.isInteger Number.isFinite Number.isNaN,",
            "  Math: Math.sign Math.trunc Math.cbrt Math.hypot Math.log2 Math.log10,",
            "  class syntax, default parameters, Promise, async, await",
            "",
            "WRONG: let amp = 30;               RIGHT: var amp = 30;",
            "WRONG: var fn = (x) => x * 2;      RIGHT: var fn = function(x) { return x * 2; }",
            "WRONG: var s = `Speed: ${spd}`;    RIGHT: var s = \"Speed: \" + spd;",
            "WRONG: var [x, y] = value;         RIGHT: var x = value[0]; var y = value[1];",
            "WRONG: arr.forEach(function(v){})  RIGHT: for (var i = 0; i < arr.length; i++) {}",
            "",
            "━━ 3B — VARIABLE DECLARATION ━━",
            "",
            "Every variable YOU create must be declared with var.",
            "AE built-in globals (time, value, thisComp, etc.) must NOT be declared with var.",
            "",
            "WRONG: amp = 30; freq = 2; wiggle(freq, amp);",
            "RIGHT: var amp = 30; var freq = 2; wiggle(freq, amp);",
            "",
            "━━ 3C — DO NOT WRAP IN A FUNCTION ━━",
            "",
            "AE expressions run as flat top-level code.",
            "",
            "WRONG:                             RIGHT:",
            "(function() {                      var amp = 30;",
            "  var amp = 30;                    wiggle(5, amp);",
            "  wiggle(5, amp);",
            "})();",
            "",
            "Exception: Helper functions defined inside the expression are fine.",
            "RIGHT (helper function):",
            "  function padZero(n) { return (n < 10 ? \"0\" : \"\") + n; }",
            "  var mins = Math.floor(time / 60);",
            "  padZero(mins) + \":\" + padZero(Math.floor(time % 60));",
            "",
            "━━ 3D — RETURN VALUE ━━",
            "",
            "AE evaluates the last expression in the code as the output.",
            "Do NOT use the keyword \"return\" at the top level. Only inside helper functions.",
            "",
            "WRONG: return wiggle(5, amp);",
            "RIGHT: wiggle(5, amp);",
            "",
            "Every conditional branch MUST evaluate to the correct output value.",
            "No branch may fall through to undefined.",
            "",
            "WRONG:                             RIGHT:",
            "if (time > 1) {                    var s;",
            "  var s = 150;                     if (time > 1) { s = 150; }",
            "}                                  else { s = 100; }",
            "// if time <= 1, AE gets undefined [s, s];",
            "",
            "━━ 3E — SEMICOLONS ━━",
            "",
            "End every statement with a semicolon, including the final return value line.",
            "",
            "━━ 3F — NO COMMENTS ALLOWED ━━",
            "",
            "Do NOT use // or /* */ comments anywhere in the expression code.",
            "Return only pure, executable math and logic. No annotations.",
            "",
            "━━ 3G — ERROR HANDLING (CRITICAL) ━━",
            "",
            "If the expression references another layer, an effect control, or any",
            "external dependency that could be missing or renamed, you MUST wrap the",
            "entire evaluation in a try/catch block. The catch block must always return",
            "the property's default value by evaluating: value",
            "",
            "This prevents the orange error banner from appearing in the user's project",
            "when a referenced layer doesn't exist yet or gets renamed.",
            "",
            "WRONG (no protection):",
            "  var p = thisComp.layer(\"Control\").transform.position;",
            "  [p[0], p[1]];",
            "",
            "RIGHT (protected):",
            "  try {",
            "    var p = thisComp.layer(\"Control\").transform.position;",
            "    [p[0], p[1]];",
            "  } catch(e) {",
            "    value;",
            "  }",
            "",
            "WRONG (no protection on effect):",
            "  var spd = effect(\"Speed Control\")(\"Slider\");",
            "  wiggle(spd, 50);",
            "",
            "RIGHT (protected):",
            "  try {",
            "    var spd = effect(\"Speed Control\")(\"Slider\");",
            "    wiggle(spd, 50);",
            "  } catch(e) {",
            "    value;",
            "  }",
            "",
            "The try/catch must wrap the evaluation — not just the layer reference.",
            "This ensures AE always gets a valid return value regardless of what fails.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 4 — AFTER EFFECTS BUILT-IN GLOBALS",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "These exist automatically in every AE expression. Never declare with var.",
            "",
            "━━ TIME & COMP ━━",
            "  time, thisComp, thisComp.duration, thisComp.width, thisComp.height,",
            "  thisComp.frameDuration, thisComp.numLayers, thisComp.name,",
            "  thisComp.displayStartTime",
            "",
            "━━ LAYER ━━",
            "  thisLayer, thisLayer.name, thisLayer.parent, thisLayer.hasParent,",
            "  thisLayer.nullLayer, index, inPoint, outPoint, startTime, width, height",
            "",
            "━━ PROPERTY ━━",
            "  value, numKeys, thisProperty, speed, velocity",
            "",
            "━━ KEYFRAME ACCESS ━━",
            "  key(i)              → keyframe object (1-based index)",
            "  key(i).time         → time of that keyframe in seconds",
            "  key(i).value        → value at that keyframe",
            "  nearestKey(t)       → keyframe object nearest to time t",
            "  nearestKey(t).index → index of nearest keyframe",
            "",
            "━━ MOTION ━━",
            "  velocity            → velocity at current time (same type as value)",
            "  speed               → scalar speed (always positive float)",
            "  velocityAtTime(t)   → velocity at a specific time",
            "  valueAtTime(t)      → value of this property at time t",
            "",
            "━━ MARKERS ━━",
            "  marker.numKeys, marker.key(i), marker.key(i).time,",
            "  marker.key(i).duration, marker.key(i).comment, marker.nearestKey(t)",
            "",
            "━━ MATH & INTERPOLATION ━━",
            "  wiggle(freq, amp)",
            "  wiggle(freq, amp, octaves, amp_mult, t)   → full form with time seed",
            "  noise(t)            → returns value -1 to 1",
            "  random()            → 0 to 1",
            "  random(max)         → 0 to max",
            "  random(min, max)    → min to max",
            "  gaussRandom()       → gaussian around 0.5",
            "  seedRandom(seed, timeless)",
            "    → seed:     any number to initialize the sequence",
            "    → timeless: true = same value every frame (stable), false = evolves over time",
            "  ease(t, t1, t2, v1, v2)",
            "  easeIn(t, t1, t2, v1, v2)",
            "  easeOut(t, t1, t2, v1, v2)",
            "  linear(t, t1, t2, v1, v2)",
            "",
            "━━ RANDOM IN LOOPS (CRITICAL) ━━",
            "",
            "If using random() inside a for loop, you MUST call seedRandom() at the",
            "start of each iteration so each element gets a unique and stable value.",
            "Failing to seed produces the same value for every iteration (useless) or",
            "violent strobing on every frame (broken).",
            "",
            "For stable per-element randomness (same value every frame):",
            "  seedRandom(index + i, true);",
            "  var val = random(minVal, maxVal);",
            "",
            "For per-element randomness that evolves over time (animated):",
            "  Do NOT use random() — it will strobe. Use noise() with a unique seed:",
            "  seedRandom(index + i, true);",
            "  var val = noise(time * speed + i * 0.5) * amplitude;",
            "",
            "WRONG (no seed in loop — all iterations get same value or strobe):",
            "  for (var i = 0; i < 10; i++) {",
            "    pts.push([random(0, 100), random(0, 100)]);",
            "  }",
            "",
            "RIGHT (stable unique value per iteration):",
            "  for (var i = 0; i < 10; i++) {",
            "    seedRandom(index + i, true);",
            "    pts.push([random(0, 100), random(0, 100)]);",
            "  }",
            "",
            "RIGHT (time-evolving unique value per iteration):",
            "  for (var i = 0; i < 10; i++) {",
            "    seedRandom(index + i, true);",
            "    var x = noise(time * 2 + i * 1.3) * 100;",
            "    var y = noise(time * 2 + i * 2.7 + 99) * 100;",
            "    pts.push([x, y]);",
            "  }",
            "",
            "━━ VECTOR MATH ━━",
            "  length(v)           → magnitude of vector",
            "  length(v1, v2)      → distance between two points",
            "  normalize(v)        → unit vector",
            "  dot(v1, v2)         → dot product",
            "  cross(v1, v2)       → cross product",
            "  clamp(val, min, max)",
            "",
            "━━ ANGLE & TIME ━━",
            "  degreesToRadians(d), radiansToDegrees(r)",
            "  timeToFrames(t), framesToTime(f)",
            "  posterizeTime(fps)  → call as a statement before other logic",
            "",
            "━━ SPACE CONVERSION ━━",
            "  toComp(pt), fromComp(pt), toWorld(pt), fromWorld(pt)",
            "  sourceRectAtTime(t) → returns object with .top .left .width .height",
            "",
            "━━ LOOPS ━━",
            "  loopOut(type, numKeyframes)  → type: \"cycle\" \"pingpong\" \"offset\" \"continue\"",
            "  loopIn(type, numKeyframes)",
            "",
            "━━ SPECIAL CONTEXT GLOBALS ━━",
            "  textIndex, textTotal       → only valid in Source Text expressions on Text Animators",
            "  createPath(pts, inT, outT, closed) → only valid on Path properties",
            "  lookAt(fromPoint, atPoint) → only valid on 3D Orientation properties",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 5 — EFFECT CONTROLS",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "Access pattern: effect(\"Descriptive Name\")(\"PropertyType\")",
            "",
            "ALLOWED PROPERTY TYPES (exact strings only):",
            "  \"Slider\"    → float number",
            "  \"Checkbox\"  → 0 or 1",
            "  \"Color\"     → [r, g, b, a] each 0-1",
            "  \"Angle\"     → degrees as float",
            "  \"Point\"     → [x, y] in comp space",
            "  \"Menu\"      → integer, 1-based index",
            "",
            "WRONG property types (do not exist):",
            "  \"Number\", \"Float\", \"Toggle\", \"Text\", \"Value\", \"Amount\"",
            "",
            "Name the control descriptively — not just \"Slider\":",
            "  RIGHT: effect(\"Wiggle Frequency\")(\"Slider\")",
            "  RIGHT: effect(\"Tint Color\")(\"Color\")",
            "  RIGHT: effect(\"Enable Effect\")(\"Checkbox\")",
            "  WRONG: effect(\"Slider\")(\"Slider\")   ← name and type are the same",
            "",
            "Always wrap effect access in try/catch per Section 3G.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 6 — RETURN VALUE TYPES BY PROPERTY",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "CRITICAL RULE: The host is After Effects ES3 (ExtendScript). You MUST output STRICT ES3 Javascript code ONLY.",
            "You CANNOT use `let`, `const`, arrow functions `=>`, template literals \\`\\`, or array methods like `.map()`, `.forEach()`, `.filter()`, `.reduce()`, `.includes()`. Use `var` and traditional `for` loops.",
            "Ensure all Javascript syntax is flawless. ALWAYS check for missing commas, unclosed brackets, or undeclared variables.",
            "VERY IMPORTANT UI RULE: The user STRONGLY PREFERS to control generated expressions via Slider Controls. Do NOT hardcode customizable numerical values (like speed, amplitude, frequency, limits) inside the code.",
            "Instead, ALWAYS attach them to external effect sliders using this exact syntax: `var myVar = effect(\"Variable Name\")(\"Slider\");`",
            "Name the sliders logically but you MUST USE one of these standard keywords so the UI can assign safe default values: 'freq', 'rate', 'decay', 'delay', 'amp', 'mult', 'speed', 'radius', 'dist', 'time', 'min', 'max', 'chance', or 'step'.",
            "Example: use `effect(\"Wiggle Freq\")(\"Slider\")` instead of `effect(\"Wiggles Per Second\")(\"Slider\")`.",
            "Remember, the Auto-Rigger will automatically create these sliders on the target layer if they don't exist, so rely on them heavily for any customizable parameter.",
            "If a mathematical expression acts on a multi-dimensional property (like Position or Scale [x, y]), DO NOT perform implicit vector arithmetic like `value + Math.sin(time)`. You MUST explicitly declare operations for each axis: `[value[0] + Math.sin(time), value[1] + Math.sin(time)]`.",
            "",
            "━━ VECTOR ARITHMETIC RULE (CRITICAL) ━━",
            "",
            "Never use implicit vector addition. ExtendScript's operator overloading for",
            "arrays is unreliable and silently fails when types mismatch.",
            "Always explicitly map each array element.",
            "",
            "WRONG: value + [Math.sin(time) * 50, 0];",
            "RIGHT: [value[0] + Math.sin(time) * 50, value[1]];",
            "",
            "WRONG: value + wiggle(2, 30);",
            "RIGHT: var w = wiggle(2, 30); [value[0] + w[0], value[1] + w[1]];",
            "",
            "WRONG: target + offset;",
            "RIGHT: [target[0] + offset[0], target[1] + offset[1]];",
            "",
            "This applies to ALL array operations: addition, subtraction, multiplication,",
            "division. Always operate element by element, explicitly.",
            "",
            "━━ Position (2D layer) ━━",
            "Returns [x, y] — pixel coordinates in comp space.",
            "WRONG: [x, y, 0]  WRONG: x  WRONG: value + [dx, dy]",
            "RIGHT: [value[0] + Math.sin(time) * 50, value[1]];",
            "",
            "━━ Position (3D layer) ━━",
            "Returns [x, y, z] — three elements.",
            "RIGHT: [value[0], value[1], value[2] + Math.sin(time) * 100];",
            "",
            "━━ Scale ━━",
            "Returns [x, y] — percentage values. Default is [100, 100].",
            "WRONG: single number  WRONG: [0.5, 0.5]  (that would be 0.5%)",
            "RIGHT: var s = 100 + Math.sin(time * 3) * 10; [s, s];",
            "",
            "━━ Rotation ━━",
            "Returns single number in degrees. Positive = clockwise in AE.",
            "WRONG: array  WRONG: radians (convert with radiansToDegrees())",
            "RIGHT: time * 90;",
            "",
            "━━ Opacity ━━",
            "Returns single number 0-100. (0 = invisible, 100 = fully visible)",
            "WRONG: 0-1 range  WRONG: array",
            "RIGHT: linear(Math.sin(time), -1, 1, 20, 100);",
            "",
            "━━ Anchor Point ━━",
            "Returns [x, y] in layer space (not comp space).",
            "RIGHT: var r = sourceRectAtTime(time); [r.left + r.width/2, r.top + r.height/2];",
            "",
            "━━ Source Text ━━",
            "Returns a string. Numbers must be explicitly converted with .toString().",
            "For multi-line output inside AE, use \\r as line separator (\\\\r in JSON).",
            "RIGHT: Math.floor(time).toString() + \" seconds\";",
            "",
            "━━ Time Remap ━━",
            "Returns single number in seconds.",
            "RIGHT: time * 2;",
            "",
            "━━ Color ━━",
            "Returns [r, g, b, a] each value 0 to 1.",
            "WRONG: [255, 0, 0, 255]",
            "RIGHT: [1, 0, 0, 1];",
            "",
            "━━ Path ━━",
            "Returns result of createPath(points, inTangents, outTangents, isClosed).",
            "RIGHT: createPath([[0,0],[100,50],[200,0]], [], [], false);",
            "",
            "━━ Stroke Width ━━",
            "Returns single positive number in pixels.",
            "",
            "━━ Any Property (Manual) ━━",
            "Returns whatever type the property expects.",
            "Use this targetProperty value when the expression is property-agnostic",
            "(loopOut, valueAtTime delay, etc.).",
            "Describe the intended property in the description field.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 7 — LAYER REFERENCES",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "Reference other layers with: thisComp.layer(\"Layer Name\")",
            "Always wrap in try/catch per Section 3G.",
            "",
            "Use only these generic names (user renames layers to match):",
            "  \"Target\", \"Control\", \"Leader\", \"Cursor\", \"Text\", \"Path\",",
            "  \"Subject\", \"Audio Amplitude\"",
            "",
            "Common property access patterns:",
            "  thisComp.layer(\"Target\").transform.position",
            "  thisComp.layer(\"Target\").transform.rotation",
            "  thisComp.layer(\"Target\").transform.scale",
            "  thisComp.layer(\"Target\").transform.opacity",
            "  thisComp.layer(\"Target\").transform.anchorPoint",
            "  thisComp.layer(\"Text\").sourceRectAtTime(time)",
            "  thisComp.layer(\"Control\").effect(\"Slider Name\")(\"Slider\")",
            "  thisComp.layer(index - 1)   → layer directly above (use sparingly)",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 8 — KEYFRAME-REACTIVE EXPRESSIONS",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "Always guard key access with numKeys check first.",
            "Always check n > 0 before calling key(n).",
            "Sample velocity slightly before the keyframe for accurate incoming velocity.",
            "",
            "RIGHT pattern:",
            "  var n = 0;",
            "  if (numKeys > 0) {",
            "    n = nearestKey(time).index;",
            "    if (key(n).time > time) { n--; }",
            "  }",
            "  if (n > 0) {",
            "    var t = time - key(n).time;",
            "    var v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);",
            "    value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);",
            "  } else {",
            "    value;",
            "  }",
            "",
            "Note: This is the one place where an if/else without an outer try/catch is",
            "acceptable — the numKeys and key access are native property reads that",
            "don't reference external layers, so they cannot throw from a missing layer.",
            "If you also reference an external layer inside a keyframe expression,",
            "wrap the entire block in try/catch.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 9 — THE \"name\" FIELD",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "  - Title Case, 3 to 6 words",
            "  - No colons, slashes, or quotes",
            "  - Parentheses allowed for clarification only",
            "",
            "WRONG: \"bounce\"  \"Make it bounce like spring\"  \"Spring Bounce: Elastic\"",
            "RIGHT: \"Spring Physics Bounce\"  \"Inertial Bounce (Keyframes)\"",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 10 — THE \"description\" FIELD",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "  - One sentence, max 200 characters, ends with a period",
            "  - Must state: what it does + what the user needs to set up",
            "  - Mention layer names in single quotes (not double quotes)",
            "  - Mention required effects by type and name",
            "  - Mention if keyframes are required",
            "  - No internal double quote characters (it's inside a JSON string)",
            "",
            "WRONG: \"Makes the layer bounce.\"",
            "RIGHT: \"Bounces elastically after each keyframe using velocity; requires at\"",
            "       \"least one keyframe on the property.\"",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 11 — THE \"targetProperty\" FIELD",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "Use EXACTLY one of these strings, character-for-character:",
            "",
            "  Position | Rotation | Scale | Opacity | Anchor Point | Source Text |",
            "  Time Remap | Path | Stroke Width | Color | Any Property (Manual)",
            "",
            "WRONG: \"position\" \"POSITION\" \"Rotation X\" \"Blurriness\" \"Size\" \"Fill Color\"",
            "If the target property isn't in this list, use \"Any Property (Manual)\"",
            "and describe the correct property in the description field.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 12 — SELF-CHECK BEFORE OUTPUT",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "JSON FORMAT",
            "  [ ] Starts with { ends with } — nothing else in the response",
            "  [ ] All four keys present",
            "  [ ] Double quotes throughout, no trailing commas",
            "",
            "EXPRESSION ENCODING",
            "  [ ] Line breaks as \\n — no actual newlines",
            "  [ ] Internal \\\" escaped as \\\\\\\"",
            "  [ ] Internal \\\\ escaped as \\\\\\\\",
            "  [ ] Regex backslashes double-escaped",
            "",
            "EXTENDSCRIPT",
            "  [ ] No let, const, =>, template literals, array/object methods",
            "  [ ] All custom variables declared with var",
            "  [ ] AE globals NOT declared with var",
            "  [ ] No top-level return keyword",
            "  [ ] No function wrapper around entire expression",
            "  [ ] Every branch evaluates to a valid return value (no undefined paths)",
            "",
            "VECTOR MATH",
            "  [ ] No implicit array arithmetic (value + [...])",
            "  [ ] All array operations done element-by-element explicitly",
            "",
            "ERROR HANDLING",
            "  [ ] Every external layer reference wrapped in try/catch",
            "  [ ] Every effect control access wrapped in try/catch",
            "  [ ] catch(e) block evaluates to: value",
            "",
            "RANDOM IN LOOPS",
            "  [ ] Every random() inside a loop preceded by seedRandom(index + i, true)",
            "  [ ] Time-evolving per-element randomness uses noise() not random()",
            "",
            "RETURN VALUE",
            "  [ ] Final line returns the correct type for this targetProperty",
            "  [ ] Position → [x, y] or [x, y, z]  (not scalar, not implicit addition)",
            "  [ ] Scale → [x, y] in percent        (not 0-1, not scalar)",
            "  [ ] Opacity → 0-100                  (not 0-1, not array)",
            "  [ ] Rotation → degrees as scalar     (not array, not radians)",
            "  [ ] Color → [r, g, b, a] 0-1        (not 0-255)",
            "  [ ] Source Text → string             (not number)",
            "",
            "FIELDS",
            "  [ ] targetProperty is one of the 11 exact allowed strings",
            "  [ ] name is 3-6 words Title Case",
            "  [ ] description is one sentence, under 200 chars, no internal \\\""
        ].join("\n");

        // Failsafe sanitization for user input to prevent user-injected quotes or backslashes from breaking the final JSON string wrap
        var safeInput = userDescription.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

        return systemRules + "\n\nGenerate an After Effects expression that does the following:\n\nUSER REQUEST: " + safeInput + "\n\nOutput only the JSON object. Nothing else.";
    }

    // Build the system prompt for DOM Scripts — MAXIMUM FIDELITY version


    function buildScriptAISystemPrompt(userDescription) {
        var systemRules = [
            "You are a specialized After Effects ExtendScript developer. You receive a",
            "description of an automated workflow or tool and return a single raw JSON object",
            "containing a working After Effects Script in ExtendScript (ES3).",
            "You are not conversational. You do not explain yourself.",
            "Your entire output is always and only a JSON object starting with { and",
            "ending with }. Nothing before it. Nothing after it.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 1 — OUTPUT FORMAT (ABSOLUTE)",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "Response is exactly one JSON object with these three keys:",
            "  \"name\"           — string",
            "  \"description\"    — string",
            "  \"script\"         — string",
            "",
            "WRONG — markdown fences:    ```json { \"name\": \"...\" } ```",
            "WRONG — text before JSON:   Here is the script: { \"name\": \"...\" }",
            "WRONG — text after JSON:    { \"name\": \"...\" } Let me know if you need changes!",
            "WRONG — missing key:        { \"name\": \"...\", \"script\": \"...\" }  // description missing",
            "WRONG — single-quote JSON:  { 'name': '...' }",
            "WRONG — trailing comma:     { \"name\": \"Foo\", \"script\": \"bar\", }",
            "RIGHT:                      { \"name\": \"...\", \"description\": \"...\", \"script\": \"...\" }",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 2 — STRING ENCODING IN THE \"script\" FIELD",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "The script is a single JSON string. Apply these encoding rules:",
            "",
            "2A — LINE BREAKS: Use \\n — never actual newlines inside the JSON string.",
            "  WRONG: \"var comp = app.project.activeItem;",
            "          comp.name;\"",
            "  RIGHT: \"var comp = app.project.activeItem;\\ncomp.name;\"",
            "",
            "2B — DOUBLE QUOTES: All \" inside the script must be escaped as \\\"",
            "  WRONG: \"layer.name === \"Background\"\"",
            "  RIGHT: \"layer.name === \\\"Background\\\"\"",
            "",
            "2C — BACKSLASHES: All \\ inside the script must be escaped as \\\\",
            "  WRONG: \"path.replace(/\\/g, \"\")\"",
            "  RIGHT: \"path.replace(/\\\\/g, \"\")\"",
            "",
            "2D — NO TABS: Use 2 spaces for indentation. Never actual tab characters.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 3 — EXTENDSCRIPT (ES3) LANGUAGE RULES",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "AE uses ExtendScript (JavaScript ES3, 1999). The following WILL break — never use them:",
            "",
            "FORBIDDEN: let, const, =>, `template literals`, [...spread], {destructuring},",
            "  for...of, for...in on arrays,",
            "  Array: .forEach .map .filter .reduce .find .some .every .includes .flat .flatMap,",
            "  Object: Object.keys Object.values Object.entries Object.assign,",
            "  String: .startsWith .endsWith .includes .repeat .padStart .padEnd,",
            "  class syntax, default parameters, Promise, async, await",
            "",
            "WRONG: let comp = app.project.activeItem;   RIGHT: var comp = app.project.activeItem;",
            "WRONG: var fn = (x) => x * 2;               RIGHT: var fn = function(x) { return x * 2; }",
            "WRONG: var s = `Layer: ${layer.name}`;       RIGHT: var s = \"Layer: \" + layer.name;",
            "WRONG: layers.forEach(function(l) {});       RIGHT: for (var i = 0; i < layers.length; i++) {}",
            "",
            "Every variable YOU create must be declared with var.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 4 — SCRIPT STRUCTURE & SCOPE (CRITICAL)",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "━━ 4A — IIFE WRAPPER (MANDATORY) ━━",
            "",
            "This script is executed by a host panel in AE global scope. You MUST wrap the",
            "entire logic inside an Immediately Invoked Function Expression (IIFE) to prevent",
            "variable leaks into the host namespace.",
            "",
            "WRONG — top level code:",
            "  var comp = app.project.activeItem;",
            "  comp.layers.addNull();",
            "",
            "RIGHT — wrapped in IIFE:",
            "  (function() {",
            "    var comp = app.project.activeItem;",
            "    comp.layers.addNull();",
            "  })();",
            "",
            "━━ 4B — NO UNDO GROUPS ━━",
            "",
            "The host application ALREADY wraps execution in app.beginUndoGroup().",
            "Do NOT include app.beginUndoGroup() or app.endUndoGroup() in your script.",
            "Including them will create nested undo groups and corrupt AE's undo history.",
            "",
            "WRONG: app.beginUndoGroup(\"My Script\"); ... app.endUndoGroup();",
            "RIGHT: Just write the logic directly inside the IIFE.",
            "",
            "━━ 4C — COMPOSITION VALIDATION (MANDATORY) ━━",
            "",
            "Almost every script requires an active composition. Always validate first.",
            "If validation fails, alert the user and return cleanly from the IIFE.",
            "",
            "RIGHT:",
            "  (function() {",
            "    var comp = app.project.activeItem;",
            "    if (!comp || !(comp instanceof CompItem)) {",
            "      alert(\"Please select an active composition first.\");",
            "      return;",
            "    }",
            "    // rest of script...",
            "  })();",
            "",
            "━━ 4D — LAYER SELECTION VALIDATION ━━",
            "",
            "If your script requires selected layers, check selectedLayers.length > 0",
            "and alert the user if nothing is selected.",
            "",
            "RIGHT:",
            "  var layers = comp.selectedLayers;",
            "  if (layers.length === 0) {",
            "    alert(\"Please select at least one layer first.\");",
            "    return;",
            "  }",
            "",
            "━━ 4E — ERROR WRAPPING ━━",
            "",
            "Wrap the core logic in try/catch to prevent silent crashes in AE.",
            "",
            "RIGHT:",
            "  try {",
            "    // main logic",
            "    alert(\"Done!\");",
            "  } catch (e) {",
            "    alert(\"Error: \" + e.toString());",
            "  }",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 5 — AFTER EFFECTS DOM REFERENCE",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "━━ 5A — PROJECT & COMPOSITION ━━",
            "",
            "  app.project                          → the open project",
            "  app.project.activeItem               → the currently open composition",
            "  app.project.items.addComp(\"Name\", w, h, pixelAspect, duration, fps)",
            "    → creates a new comp. pixelAspect is usually 1.",
            "  comp.name                            → comp name as string",
            "  comp.width, comp.height              → dimensions in pixels",
            "  comp.duration                        → duration in seconds",
            "  comp.frameRate                       → frames per second",
            "  comp.numLayers                       → number of layers",
            "  comp.layer(index)                    → get layer by 1-based index",
            "  comp.layer(\"Name\")                   → get layer by name",
            "  comp.selectedLayers                  → array of selected layers",
            "",
            "━━ 5B — LAYER TYPES AND CREATION ━━",
            "",
            "  comp.layers.addNull(duration)        → adds a Null Object",
            "  comp.layers.addText(\"string\")         → adds a Text layer",
            "  comp.layers.addSolid([r,g,b], \"Name\", w, h, pixelAspect, duration)",
            "    → r,g,b are 0-1 values. duration is optional.",
            "  comp.layers.addShape()               → adds an empty Shape layer",
            "  comp.layers.addCamera(\"Name\", [x,y]) → adds a Camera",
            "  comp.layers.addLight(\"Name\", [x,y])  → adds a Light",
            "",
            "Layer type checking:",
            "  layer instanceof AVLayer             → footage, solid, pre-comp",
            "  layer instanceof TextLayer           → text layer",
            "  layer instanceof ShapeLayer          → shape layer",
            "  layer instanceof CameraLayer         → camera",
            "  layer instanceof LightLayer          → light",
            "  layer.nullLayer                      → boolean, true if it is a null",
            "",
            "━━ 5C — LAYER PROPERTIES ━━",
            "",
            "Access transform properties using matchNames (more reliable than display names):",
            "  layer.property(\"ADBE Transform Group\").property(\"ADBE Position\")     → Position",
            "  layer.property(\"ADBE Transform Group\").property(\"ADBE Scale\")        → Scale",
            "  layer.property(\"ADBE Transform Group\").property(\"ADBE Rotate Z\")     → Rotation",
            "  layer.property(\"ADBE Transform Group\").property(\"ADBE Opacity\")      → Opacity",
            "  layer.property(\"ADBE Transform Group\").property(\"ADBE Anchor Point\") → Anchor Point",
            "",
            "Shorthand (also reliable):",
            "  layer.transform.position",
            "  layer.transform.scale",
            "  layer.transform.rotation",
            "  layer.transform.opacity",
            "  layer.transform.anchorPoint",
            "",
            "Other layer properties:",
            "  layer.name                           → layer name (read/write string)",
            "  layer.enabled                        → boolean visibility",
            "  layer.solo                           → boolean solo",
            "  layer.locked                         → boolean lock",
            "  layer.inPoint                        → in point in seconds (read/write)",
            "  layer.outPoint                       → out point in seconds (read/write)",
            "  layer.startTime                      → start time offset in seconds",
            "  layer.label                          → label color index (1-16)",
            "  layer.index                          → 1-based position in layer stack",
            "  layer.parent                         → parent layer (or null)",
            "",
            "━━ 5D — SETTING VALUES AND KEYFRAMES ━━",
            "",
            "Set a static value:",
            "  prop.setValue(value)",
            "",
            "Set a value at a specific time (creates a keyframe):",
            "  prop.setValueAtTime(timeInSeconds, value)",
            "",
            "Add a keyframe at current time:",
            "  prop.addKey(timeInSeconds)",
            "",
            "CRITICAL — value types must match the property exactly:",
            "  Position (2D layer): prop.setValue([x, y]);         → array of 2 numbers in pixels",
            "  Position (3D layer): prop.setValue([x, y, z]);      → array of 3 numbers",
            "  Scale:               prop.setValue([100, 100]);      → percentage, not 0-1",
            "  Rotation:            prop.setValue(45);             → degrees as single number",
            "  Opacity:             prop.setValue(100);            → 0 to 100, not 0 to 1",
            "  Color (Solid):       [r, g, b] each 0 to 1",
            "",
            "WRONG: layer.transform.position.setValue(960);        // scalar instead of array",
            "WRONG: layer.transform.scale.setValue([1, 1]);         // 0-1 range instead of 0-100",
            "WRONG: layer.transform.opacity.setValue(0.5);          // 0-1 range instead of 0-100",
            "RIGHT: layer.transform.position.setValue([960, 540]);",
            "RIGHT: layer.transform.scale.setValue([100, 100]);",
            "RIGHT: layer.transform.opacity.setValue(50);",
            "",
            "━━ 5E — ADDING AND CONFIGURING EFFECTS ━━",
            "",
            "Add an effect to a layer:",
            "  var fx = layer.property(\"ADBE Effect Parade\").addProperty(matchName);",
            "",
            "Common effect matchNames (reliable — always prefer matchName over display name):",
            "  \"ADBE Gaussian Blur 2\"               → Gaussian Blur",
            "  \"ADBE Drop Shadow\"                   → Drop Shadow",
            "  \"ADBE Glo2\"                          → Glow",
            "  \"ADBE Easy Levels2\"                  → Levels",
            "  \"ADBE Hue Saturation\"                → Hue/Saturation",
            "  \"ADBE Tint\"                          → Tint",
            "  \"ADBE Fill\"                          → Fill",
            "  \"ADBE Stroke\"                        → Stroke",
            "  \"ADBE Tritone\"                       → Tritone",
            "  \"ADBE Slider Control\"                → Slider Control (Expression Control)",
            "  \"ADBE Color Control\"                 → Color Control (Expression Control)",
            "  \"ADBE Checkbox Control\"              → Checkbox Control (Expression Control)",
            "",
            "If you are not 100% certain of a matchName, use the display name as fallback:",
            "  layer.property(\"Effects\").addProperty(\"Gaussian Blur\");  // display name fallback",
            "",
            "After adding, set effect properties by their own matchNames or display names:",
            "  var blur = layer.property(\"ADBE Effect Parade\").addProperty(\"ADBE Gaussian Blur 2\");",
            "  blur.property(\"ADBE Gaussian Blur 2-0001\").setValue(30);  // Blurriness",
            "  blur.property(\"ADBE Gaussian Blur 2-0002\").setValue(1);   // Dimensions (0=both)",
            "",
            "━━ 5F — TEXT LAYER PROPERTIES ━━",
            "",
            "Access text content:",
            "  layer.property(\"ADBE Text Properties\").property(\"ADBE Text Document\").setValue(new TextDocument(\"Hello\"));",
            "",
            "After setting text, you can also configure the TextDocument object:",
            "  var textDoc = new TextDocument(\"Hello World\");",
            "  textDoc.fontSize = 72;",
            "  textDoc.fillColor = [1, 1, 1];   // White, 0-1 range",
            "  textDoc.justification = ParagraphJustification.CENTER_JUSTIFY;",
            "  layer.property(\"ADBE Text Properties\").property(\"ADBE Text Document\").setValue(textDoc);",
            "",
            "━━ 5G — SHAPE LAYERS ━━",
            "",
            "Shape layers use a contents group. Add shapes via their matchNames:",
            "  var contents = layer.property(\"ADBE Root Vectors Group\");",
            "  var grp = contents.addProperty(\"ADBE Vector Group\");",
            "  grp.name = \"Rectangle Group\";",
            "  var rect = grp.property(\"ADBE Vectors Group\").addProperty(\"ADBE Vector Shape - Rect\");",
            "  rect.property(\"ADBE Vector Rect Size\").setValue([200, 100]);",
            "  var fill = grp.property(\"ADBE Vectors Group\").addProperty(\"ADBE Vector Graphic - Fill\");",
            "  fill.property(\"ADBE Vector Fill Color\").setValue([1, 0, 0, 1]);  // red RGBA 0-1",
            "",
            "━━ 5H — SOURCE RECT AND CENTERING ━━",
            "",
            "To get the bounding box of a text or shape layer:",
            "  var rect = layer.sourceRectAtTime(0, false);",
            "  rect.left, rect.top, rect.width, rect.height",
            "",
            "To center a layer's anchor point to its content:",
            "  var rect = layer.sourceRectAtTime(0, false);",
            "  layer.transform.anchorPoint.setValue([rect.left + rect.width/2, rect.top + rect.height/2]);",
            "",
            "━━ 5I — PARENTING ━━",
            "",
            "Set a layer's parent:",
            "  childLayer.parent = parentLayer;",
            "",
            "Remove parent:",
            "  childLayer.parent = null;",
            "",
            "━━ 5J — EXPRESSIONS ON PROPERTIES (FROM SCRIPTS) ━━",
            "",
            "You can set expressions on properties from a script:",
            "  layer.transform.position.expression = \"wiggle(2, 30);\";",
            "  layer.transform.rotation.expression = \"time * 90;\";",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 6 — THE \"name\" AND \"description\" FIELDS",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "name:",
            "  - Title Case, 3 to 6 words",
            "  - No colons, slashes, or internal quotes",
            "  - Must describe what the script DOES, not what it is",
            "  WRONG: \"script\"  \"Layer Tool\"  \"My Automation\"",
            "  RIGHT: \"Center All Selected Layers\"  \"Add Glow to Selected\"  \"Distribute Layers Vertically\"",
            "",
            "description:",
            "  - One sentence, max 200 characters, ends with a period",
            "  - State: what the script does + what must be selected/set up before running",
            "  - Use single quotes if quoting names",
            "  - No internal double quote characters",
            "  WRONG: \"Moves layers.\"",
            "  RIGHT: \"Centers the anchor point of each selected layer to its content bounding box. Select layers before running.\"",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 7 — SELF-CHECK BEFORE OUTPUT",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "JSON FORMAT",
            "  [ ] Response starts with { and ends with } — nothing else",
            "  [ ] All three keys present: name, description, script",
            "  [ ] Double quotes throughout, no trailing commas",
            "",
            "SCRIPT ENCODING",
            "  [ ] Line breaks encoded as \\n — no actual newlines in the JSON string",
            "  [ ] Internal \" escaped as \\\"",
            "  [ ] Internal \\ escaped as \\\\",
            "  [ ] No tab characters — spaces only",
            "",
            "EXTENDSCRIPT",
            "  [ ] No let, const, =>, template literals, array/object/string ES6 methods",
            "  [ ] All variables declared with var",
            "  [ ] Entire script wrapped in (function() { ... })();",
            "  [ ] No app.beginUndoGroup() anywhere",
            "  [ ] Validates comp instanceof CompItem before acting",
            "  [ ] Validates selectedLayers if layers are required",
            "  [ ] Core logic wrapped in try/catch",
            "  [ ] Position/Scale/Color use correct array types",
            "",
            "FIELDS",
            "  [ ] name is 3-6 words Title Case",
            "  [ ] description is one sentence, under 200 chars, no internal \""
        ].join("\n");

        var safeInput = userDescription.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

        return systemRules + "\n\nGenerate an After Effects script that does the following:\n\nUSER REQUEST: " + safeInput + "\n\nOutput only the JSON object. Nothing else.";
    }

    // Scan generated script for forbidden ES6+ patterns.
    // Returns an ARRAY of violation strings (empty = clean).
    // Used by executeExtendScript (needs array) and validateScriptBool (needs bool).
    function validateScript(scriptStr) {
        var checks = [
            { re: /\blet\b/,            label: "let keyword" },
            { re: /\bconst\b/,          label: "const keyword" },
            { re: new RegExp("=>"),     label: "arrow function (=>)" },
            { re: /\.forEach\b/,        label: ".forEach()" },
            { re: /\.map\b/,            label: ".map()" },
            { re: /\.filter\b/,         label: ".filter()" },
            { re: /\.reduce\b/,         label: ".reduce()" },
            { re: /\.includes\b/,       label: ".includes()" },
            { re: /\.some\b/,           label: ".some()" },
            { re: /\.every\b/,          label: ".every()" },
            { re: /\.find\b/,           label: ".find()" },
            { re: /\.findIndex\b/,      label: ".findIndex()" },
            { re: /\.flat\b/,           label: ".flat()" },
            { re: /\.flatMap\b/,        label: ".flatMap()" },
            { re: /\bclass\s/,          label: "class declaration" },
            { re: /\bfor\s*\(.*\bof\b/, label: "for...of loop" },
            { re: /\basync\b/,          label: "async keyword" },
            { re: /\bawait\b/,          label: "await keyword" },
            { re: /\bPromise\b/,        label: "Promise" },
            { re: /Object\.(keys|values|entries|assign)\b/, label: "Object.keys/values/entries/assign" },
            { re: /`/,                  label: "template literal (`)" },
            { re: /\bbeginUndoGroup\b/, label: "beginUndoGroup (host wraps)" },
            { re: /\bendUndoGroup\b/,   label: "endUndoGroup (host wraps)" }
        ];
        var violations = [];
        for (var i = 0; i < checks.length; i++) {
            if (checks[i].re.test(scriptStr)) violations.push(checks[i].label);
        }
        return violations; // [] = valid
    }

    // Boolean wrapper for Script tab UI validator (legacy callers)
    function validateScriptBool(scriptStr) {
        return validateScript(scriptStr).length === 0;
    }

    function modelUsesBearerAuth(model) {
        return (model !== "Claude" && model !== "Gemini");
    }

    function modelUsesOpenAIResponseShape(model) {
        return (model !== "Claude" && model !== "Gemini");
    }

    function modelRequiresApiKey(model) {
        return (model !== "Custom Endpoint");
    }

    function normalizeModelTier(tierHint) {
        var tier = (tierHint || "small").toString().toLowerCase();
        if (tier === "small" || tier === "medium" || tier === "large" || tier === "max") return tier;
        return "small";
    }

    function pickProviderModel(model, tierHint) {
        var tier = normalizeModelTier(tierHint);
        if (model === "ChatGPT") {
            if (tier === "large" || tier === "max") return "gpt-4o";
            return "gpt-4o-mini";
        }
        if (model === "Claude") {
            if (tier === "small") return "claude-3-5-haiku-20241022"; // haiku stays stable
            return "claude-sonnet-4-5"; // latest Claude Sonnet
        }
        if (model === "Kimi") {
            if (tier === "large" || tier === "max") return "moonshot-v1-32k";
            return "moonshot-v1-8k";
        }
        if (model === "OpenRouter") {
            if (tier === "large" || tier === "max") return "openai/gpt-4o";
            if (tier === "medium") return "google/gemini-2.5-flash";
            return "google/gemini-2.5-flash-lite-preview-02-05:free";
        }
        if (model === "Groq") {
            return "llama-3.3-70b-versatile";
        }
        if (model === "Cerebras") {
            if (tier === "small") return "llama3.1-8b";
            return "llama-3.3-70b";
        }
        if (model === "NVIDIA NIM") {
            if (tier === "small") return "meta/llama-3.1-8b-instruct";
            return "meta/llama-3.1-70b-instruct";
        }
        if (model === "GitHub Models") {
            if (tier === "large" || tier === "max") return "gpt-4o";
            return "gpt-4o-mini";
        }
        if (model === "Mistral") {
            if (tier === "small") return "mistral-small-latest";
            return "mistral-medium-latest";
        }
        if (model === "Custom Endpoint") {
            return (apiSettings.customModel && apiSettings.customModel !== "") ? apiSettings.customModel : "local-model";
        }
        return "";
    }

    function shortPreview(str, maxLen) {
        if (!str) return "";
        var max = maxLen || 280;
        var clean = String(str).replace(/\s+/g, " ");
        return clean.length > max ? clean.substring(0, max) + "..." : clean;
    }

    function extractModelText(model, jsonResp) {
        if (modelUsesOpenAIResponseShape(model) && jsonResp.choices && jsonResp.choices.length > 0) {
            return jsonResp.choices[0].message.content;
        }
        if (model === "Claude" && jsonResp.content && jsonResp.content.length > 0) {
            return jsonResp.content[0].text;
        }
        if (model === "Gemini" && jsonResp.candidates && jsonResp.candidates.length > 0 &&
            jsonResp.candidates[0].content && jsonResp.candidates[0].content.parts &&
            jsonResp.candidates[0].content.parts.length > 0) {
            return jsonResp.candidates[0].content.parts[0].text;
        }
        return "";
    }

    function callModelJSON(model, apiKey, apiUrl, payloadStr, timeoutSec, statusFn, requestTag) {
        var tmpFile = new File(Folder.temp.fullName + "/balongra_api_payload_" + (new Date().getTime()) + "_" + Math.floor(Math.random() * 99999) + ".json");
        var tag = requestTag || "request";
        try {
            tmpFile.encoding = "UTF-8";
            if (!tmpFile.open("w")) return { ok: false, error: "ERROR: Could not open temp file for " + tag + "." };
            tmpFile.write(payloadStr);
            tmpFile.close();
        } catch (fe) {
            return { ok: false, error: "ERROR: Failed to write temp file for " + tag + ": " + fe.toString() };
        }

        var sanitizedKey = (apiKey || "").replace(/[^a-zA-Z0-9_.\-\+\/=~]/g, "");
        // Sanitize URL to prevent shell injection via malicious custom endpoints
        var sanitizedUrl = (apiUrl || "").replace(/['"`$;&|<>\r\n\\]/g, "");
        var cmd = "";
        var isMac = ($.os.indexOf("Mac") !== -1);
        var timeout = timeoutSec || 75;
        if (isMac) {
            var hdr = " -H 'Content-Type: application/json'";
            if (modelUsesBearerAuth(model) && sanitizedKey !== "") hdr += " -H 'Authorization: Bearer " + sanitizedKey + "'";
            if (model === "Claude") hdr += " -H 'x-api-key: " + sanitizedKey + "' -H 'anthropic-version: 2023-06-01'";
            if (model === "Gemini" && sanitizedKey !== "") hdr += " -H 'x-goog-api-key: " + sanitizedKey + "'";
            cmd = 'curl -sS -m ' + timeout + ' -w "\\n__BALONGRA_HTTP__:%{http_code}" -X POST "' + sanitizedUrl + '"' + hdr + ' -d @"' + tmpFile.fsName + '"';
        } else {
            var psH = "@{'Content-Type'='application/json';";
            if (modelUsesBearerAuth(model) && sanitizedKey !== "") psH += "'Authorization'='Bearer " + sanitizedKey + "'";
            if (model === "Claude") psH += "'x-api-key'='" + sanitizedKey + "';'anthropic-version'='2023-06-01'";
            if (model === "Gemini" && sanitizedKey !== "") psH += "'x-goog-api-key'='" + sanitizedKey + "'";
            psH += "}";
            cmd = "powershell -Command \"$body = Get-Content -Raw -Path '" + tmpFile.fsName.replace(/'/g, "''") +
                "'; try { $resp = Invoke-WebRequest -Uri '" + sanitizedUrl.replace(/'/g, "''") + "' -Method Post -Headers " + psH +
                " -Body $body -ContentType 'application/json' -TimeoutSec " + timeout +
                "; '__BALONGRA_HTTP__:' + $resp.StatusCode + '\\n' + $resp.Content } catch { '__BALONGRA_HTTP__:000\\n' + $_.Exception.Message }\"";
        }

        var responseStr = "";
        var shellErr = null;
        try {
            responseStr = system.callSystem(cmd);
        } catch (err) {
            shellErr = err;
        } finally {
            try { if (tmpFile && tmpFile.exists) tmpFile.remove(); } catch (x) { }
        }
        if (shellErr) {
            return { ok: false, error: "ERROR: Network call failed for " + tag + ": " + shellErr.toString() };
        }

        if (!responseStr || responseStr === "") {
            return { ok: false, error: "ERROR: API returned an empty response for " + tag + "." };
        }

        var httpCode = 0;
        var body = responseStr;
        var marker = "__BALONGRA_HTTP__:";
        var markerIdx = responseStr.lastIndexOf(marker);
        if (markerIdx !== -1) {
            var bodyPart = responseStr.substring(0, markerIdx);
            var codePart = responseStr.substring(markerIdx + marker.length);
            if (codePart.indexOf("\n") !== -1) {
                var firstLine = codePart.substring(0, codePart.indexOf("\n"));
                var remainder = codePart.substring(codePart.indexOf("\n") + 1);
                httpCode = parseInt(firstLine, 10) || 0;
                body = remainder !== "" ? remainder : bodyPart;
            } else {
                httpCode = parseInt(codePart, 10) || 0;
                body = bodyPart;
            }
        }

        if (httpCode !== 0 && (httpCode < 200 || httpCode >= 300)) {
            return {
                ok: false,
                httpCode: httpCode,
                raw: body,
                error: "ERROR: " + model + " returned HTTP " + httpCode + " for " + tag + ". " + shortPreview(body, 360)
            };
        }

        var jsonResp = null;
        try {
            jsonResp = JSON.parse(body);
        } catch (pe) {
            return {
                ok: false,
                httpCode: httpCode,
                raw: body,
                error: "ERROR: Could not parse API response for " + tag + ". " + shortPreview(body, 320)
            };
        }

        if (jsonResp.error) {
            var errMsg = jsonResp.error.message || jsonResp.error.type || JSON.stringify(jsonResp.error);
            return {
                ok: false,
                httpCode: httpCode,
                raw: body,
                error: "ERROR (API): " + errMsg
            };
        }

        return { ok: true, json: jsonResp, raw: body, httpCode: httpCode };
    }


    // Build API payload as a proper JS object, then stringify
    function buildPayload(model, systemPrompt, userMessage, maxTok, tierHint) {
        var tok = maxTok || 4096;
        var tier = normalizeModelTier(tierHint);
        var obj = {};
        if (model === "ChatGPT") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.temperature = 0.2;
            obj.messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ];
        } else if (model === "Claude") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.system = systemPrompt;
            obj.messages = [{ role: "user", content: userMessage }];
        } else if (model === "Gemini") {
            obj.system_instruction = { parts: [{ text: systemPrompt }] };
            obj.contents = [{ role: "user", parts: [{ text: userMessage }] }];
            obj.generationConfig = { maxOutputTokens: tok, temperature: 0.2 };
        } else if (model === "Kimi") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.temperature = 0.2;
            obj.messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
        } else if (model === "OpenRouter") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.temperature = 0.2;
            obj.messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
        } else if (model === "Groq") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.temperature = 0.2;
            obj.messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
        } else if (model === "Cerebras") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.temperature = 0.2;
            obj.messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
        } else if (model === "NVIDIA NIM") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.temperature = 0.2;
            obj.messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
        } else if (model === "GitHub Models") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.temperature = 0.2;
            obj.messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
        } else if (model === "Mistral") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.temperature = 0.2;
            obj.messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
        } else if (model === "Custom Endpoint") {
            obj.model = pickProviderModel(model, tier);
            obj.max_tokens = tok;
            obj.temperature = 0.2;
            obj.messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
        }
        return JSON.stringify(obj);
    }

    // 1. Hardened JSON parsing pipeline (String and depth-aware)
    function extractJSON(rawResponse) {
        if (typeof JSON === "undefined") { alert("Your version of After Effects is too old to run AI tools. Please update to AE 2019 or newer, or enable modern Javascript engine."); return null; }

        var startIndex = -1;
        var jsonBlock = rawResponse.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonBlock) {
            rawResponse = jsonBlock[1];
            startIndex = 0;
        } else {
            startIndex = rawResponse.indexOf('{');
        }
        if (startIndex === -1) return null;

        var depth = 0;
        var inString = false;
        var escapeNext = false;
        var endIndex = -1;

        for (var i = startIndex; i < rawResponse.length; i++) {
            var c = rawResponse[i];

            // Toggle string state, ignoring escaped quotes (e.g., \")
            if (!escapeNext && c === '"') {
                inString = !inString;
            }

            // Track if the next character is escaped
            escapeNext = (!escapeNext && c === '\\');

            // Only count depth if we are NOT inside a string literal
            if (!inString) {
                if (c === '{') depth++;
                if (c === '}') depth--;
                if (depth === 0) {
                    endIndex = i;
                    break;
                }
            }
        }

        if (endIndex === -1) return null;

        try {
            var obj = JSON.parse(rawResponse.substring(startIndex, endIndex + 1));
            // Sanitize newlines for Mac ScriptUI (converts \n to \r)
            if (obj && typeof obj.expression === "string") {
                // Retain comments (URL-safe). Mac ScriptUI evaluates \r as a visual newline.
                obj.expression = obj.expression.replace(/\r\n|\n/g, "\r");
            }
            if (obj && typeof obj.description === "string") {
                obj.description = obj.description.replace(/\r\n|\n/g, "\r");
            }
            return obj;
        } catch (e) {
            return null; // Failsafe for severe malformation
        }
    }

    // 2. Hardened JSON Array parser specifically for Balongra Agent workflow
    function extractJSONArray(rawResponse) {
        if (typeof JSON === "undefined") { alert("Your version of After Effects is too old to run AI tools. Please update to AE 2019 or newer, or enable modern Javascript engine."); return null; }

        var startIndex = -1;
        var jsonBlock = rawResponse.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (jsonBlock) {
            rawResponse = jsonBlock[1];
            startIndex = 0;
        } else {
            startIndex = rawResponse.indexOf('[');
        }
        if (startIndex === -1) return null;

        var depth = 0;
        var inString = false;
        var escapeNext = false;
        var endIndex = -1;

        for (var i = startIndex; i < rawResponse.length; i++) {
            var c = rawResponse[i];
            if (!escapeNext && c === '"') inString = !inString;
            escapeNext = (!escapeNext && c === '\\');

            if (!inString) {
                if (c === '[') depth++;
                if (c === ']') depth--;
                if (depth === 0) {
                    endIndex = i;
                    break;
                }
            }
        }

        if (endIndex === -1) return null;

        try {
            return JSON.parse(rawResponse.substring(startIndex, endIndex + 1));
        } catch (e) {
            return null; // Failsafe
        }
    }

    // 2. Scan for forbidden ES6 syntax
    function validateExpression(expr) {
        var forbidden = [
            /\blet\b/, /\bconst\b/, new RegExp("=>"),
            /\.forEach\b/, /\.map\b/, /\.filter\b/,
            /\.reduce\b/, /\.includes\b/, /\.some\b/,
            /\.every\b/, /\.find\b/, /\.findIndex\b/,
            /\.flat\b/, /\.flatMap\b/,
            /\bclass\s/, /\bfor\s*\(.*\bof\b/,
            /\basync\b/, /\bawait\b/, /\bPromise\b/,
            /Object\.(keys|values|entries|assign)\b/,
            /`/  // template literals
        ];
        for (var i = 0; i < forbidden.length; i++) {
            if (forbidden[i].test(expr)) {
                return false;
            }
        }
        return true;
    }

    function sanitizeExpressionForAE(expr) {
        var out = expr || "";
        out = out.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
        out = out.replace(/[\u2018\u2019]/g, "'");
        out = out.replace(/[\u201C\u201D]/g, "\"");
        return out;
    }

    function setExpressionOnPropertySafely(prop, layerForAutoRig, expressionText) {
        if (!prop || !prop.canSetExpression) return { ok: false, msg: "Property cannot accept expressions." };
        var expr = sanitizeExpressionForAE(expressionText || "");
        try {
            var rigReport = null;

            // ── Pass 1: apply expression cold (no rigging yet) ───────────────────
            // Only auto-rig AFTER we see an error that rigging can fix.
            // Pre-emptive rigging created orphan effects when the expression was
            // already valid — those effects were never removed on failure.
            prop.expression = expr;
            try { prop.expressionEnabled = true; } catch (ee) { }

            if (prop.expressionError && prop.expressionError !== "") {
                var errLow = String(prop.expressionError || "").toLowerCase();
                var needsControlRepair = (errLow.indexOf("effect") !== -1 || errLow.indexOf("slider") !== -1 ||
                    errLow.indexOf("checkbox") !== -1 || errLow.indexOf("color") !== -1 ||
                    errLow.indexOf("property or method named") !== -1 || errLow.indexOf("undefined") !== -1);

                // ── Pass 2: run auto-rig only when there's an error worth repairing ─
                if (layerForAutoRig && needsControlRepair) {
                    rigReport = autoRigControls(layerForAutoRig, expr, {
                        repairConflicts: true,
                        forceResetConflicts: true
                    });
                    // Re-apply after rig has created the required controls
                    prop.expression = expr;
                    try { prop.expressionEnabled = true; } catch (eee) { }
                }

                if (prop.expressionError && prop.expressionError !== "") {
                    var extra = "";
                    if (rigReport && (rigReport.created > 0 || rigReport.repaired > 0)) {
                        extra = " (auto-rig created " + rigReport.created + ", repaired " + rigReport.repaired + ")";
                    }
                    return { ok: false, msg: prop.expressionError + extra };
                }
            }
            return { ok: true, msg: "" };
        } catch (e) {
            return { ok: false, msg: e.toString() };
        }
    }

    // Build UI

    // ============================================================
    // BALONGRA AGENT — MCP-STYLE INTERNAL TOOL LIBRARY
    // All tools run inside a single undo group started by the
    // pipeline runner. No eval(). No external bridge required.
    // ============================================================

    // --- Shared lookup helpers ---

    function agentFindComp(compName, context) {
        // Priority: context cache → named project search → active item
        if (compName && context && context.comps && context.comps[compName]) {
            return context.comps[compName];
        }
        if (compName) {
            for (var i = 1; i <= app.project.numItems; i++) {
                var item = app.project.item(i);
                if (item instanceof CompItem && item.name === compName) return item;
            }
        }
        var active = app.project.activeItem;
        if (active instanceof CompItem) return active;
        return null;
    }

    function agentNormalizeName(str) {
        var s = String(str || "").toLowerCase();
        s = s.replace(/[\u2018\u2019]/g, "'");
        s = s.replace(/[\u201C\u201D]/g, "\"");
        s = s.replace(/["'`]/g, "");
        s = s.replace(/[_\-]+/g, " ");
        s = s.replace(/[^\w\s]+/g, " ");
        s = s.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        return s;
    }

    function agentRememberProperty(context, compName, layerName, propertyName) {
        if (!context || !propertyName) return;
        context.lastProperty = propertyName;
        if (!context.lastPropertyByLayer) context.lastPropertyByLayer = {};
        if (layerName) {
            var k = (compName || "") + "|" + layerName;
            context.lastPropertyByLayer[k] = propertyName;
        }
    }

    function agentGuessProperty(context, compName, layerName, fallback) {
        if (context && context.lastPropertyByLayer && layerName) {
            var k = (compName || "") + "|" + layerName;
            if (context.lastPropertyByLayer[k]) return context.lastPropertyByLayer[k];
        }
        if (context && context.lastProperty) return context.lastProperty;
        return fallback || "position";
    }

    function agentApplyTemporalEaseAtKeySafe(prop, keyIndex, inEase, outEase) {
        var dimsPrimary = 1;
        try {
            if (prop.value instanceof Array) dimsPrimary = prop.value.length;
        } catch (e) { dimsPrimary = 1; }
        var tries = [dimsPrimary, 1, 2, 3, 4];
        var used = {};
        var lastErr = null;
        for (var ti = 0; ti < tries.length; ti++) {
            var n = tries[ti];
            if (!n || n < 1 || n > 4) continue;
            if (used[n]) continue;
            used[n] = true;
            var eInArr = [], eOutArr = [];
            for (var d = 0; d < n; d++) { eInArr.push(inEase); eOutArr.push(outEase); }
            try {
                prop.setTemporalEaseAtKey(keyIndex, eInArr, eOutArr);
                return { ok: true, dims: n };
            } catch (eTry) {
                lastErr = eTry;
            }
        }
        return { ok: false, msg: lastErr ? lastErr.toString() : "setTemporalEaseAtKey failed" };
    }

    function agentFindLayer(comp, layerName, context, compName) {
        if (!comp) return null;

        if (!layerName && context && context.lastLayer) {
            try { if (context.lastLayer.name !== undefined) return context.lastLayer; } catch (e0) { }
        }
        if (!layerName) return null;

        var requestRaw = String(layerName).replace(/^\s+|\s+$/g, "");
        requestRaw = requestRaw.replace(/^["'`]+|["'`]+$/g, "");
        var requestNorm = agentNormalizeName(requestRaw);

        // Context cache (stores by "compName|layerName")
        var cacheKeyA = (compName || comp.name) + "|" + requestRaw;
        var cacheKeyB = (compName || comp.name) + "|" + layerName;
        if (context && context.layers) {
            var cached = context.layers[cacheKeyA] || context.layers[cacheKeyB];
            if (cached) {
                // Validate the cached ref is still alive — deleted layers throw on any access
                var cacheValid = false;
                try {
                    var _testName = cached.name; // throws if layer was deleted
                    // Also verify the layer still belongs to this comp by index
                    if (cached.index >= 1 && cached.index <= comp.numLayers) {
                        var _probe = comp.layer(cached.index);
                        if (_probe && _probe.name === _testName) cacheValid = true;
                    }
                } catch (cacheErr) { cacheValid = false; }
                if (cacheValid) return cached;
                // Evict stale entry
                try { delete context.layers[cacheKeyA]; } catch (e) {}
                try { delete context.layers[cacheKeyB]; } catch (e) {}
            }
        }

        // Exact and case-insensitive matches
        for (var i = 1; i <= comp.numLayers; i++) {
            var l = comp.layer(i);
            if (l.name === requestRaw || l.name === layerName) {
                if (context && context.layers) context.layers[cacheKeyA] = l;
                return l;
            }
        }
        var requestLower = requestRaw.toLowerCase();
        for (var j = 1; j <= comp.numLayers; j++) {
            var l2 = comp.layer(j);
            if (String(l2.name).toLowerCase() === requestLower) {
                if (context && context.layers) context.layers[cacheKeyA] = l2;
                return l2;
            }
        }

        // Normalized/fuzzy fallback
        var best = null;
        var bestScore = 0;
        for (var k = 1; k <= comp.numLayers; k++) {
            var cand = comp.layer(k);
            var candNorm = agentNormalizeName(cand.name);
            if (!candNorm) continue;
            if (candNorm === requestNorm) {
                if (context && context.layers) context.layers[cacheKeyA] = cand;
                return cand;
            }
            var score = 0;
            if (candNorm.indexOf(requestNorm) !== -1 || requestNorm.indexOf(candNorm) !== -1) {
                var minLen = Math.min(candNorm.length, requestNorm.length);
                var maxLen = Math.max(candNorm.length, requestNorm.length);
                score = (minLen / Math.max(maxLen, 1));
            } else {
                var reqParts = requestNorm.split(" ");
                var hit = 0;
                for (var rp = 0; rp < reqParts.length; rp++) {
                    var part = reqParts[rp];
                    if (part && candNorm.indexOf(part) !== -1) hit++;
                }
                if (reqParts.length > 0) score = hit / reqParts.length;
            }
            if (score > bestScore) {
                bestScore = score;
                best = cand;
            }
        }
        // Threshold of 0.70 (vs old 0.55): require 70% word overlap before accepting a fuzzy match.
        // The lower threshold caused short layer names like "BG" to match "Button" on a single shared
        // character, silently targeting the wrong layer. 0.70 still handles common typos and
        // underscore/hyphen variations while avoiding false positives on unrelated short names.
        if (best && bestScore >= 0.70) {
            if (context && context.layers) context.layers[cacheKeyA] = best;
            return best;
        }

        if (context && context.lastLayer) {
            try {
                var lastNorm = agentNormalizeName(context.lastLayer.name || "");
                // Require that the shorter name is at least 4 chars and represents a
                // substantial portion of the longer one — prevents "BG" matching "Button"
                // or a 2-letter abbreviation matching any layer that shares those letters.
                var minLen = Math.min(lastNorm.length, requestNorm.length);
                var maxLen = Math.max(lastNorm.length, requestNorm.length);
                var hasOverlap = (lastNorm.indexOf(requestNorm) !== -1 || requestNorm.indexOf(lastNorm) !== -1);
                var overlapRatio = maxLen > 0 ? (minLen / maxLen) : 0;
                if (lastNorm && hasOverlap && minLen >= 4 && overlapRatio >= 0.70) {
                    return context.lastLayer;
                }
            } catch (e1) { }
        }
        return null;
    }

    function agentShortList(list, maxCount) {
        if (!list || list.length === 0) return "(none)";
        var maxN = (maxCount !== undefined) ? maxCount : 4;
        if (maxN < 1) maxN = 1;
        var out = [];
        var lim = Math.min(list.length, maxN);
        for (var i = 0; i < lim; i++) out.push(String(list[i]));
        if (list.length > lim) out.push("+" + (list.length - lim) + " more");
        return out.join(", ");
    }

    // Resolves layer targets for tools that can run on one or many layers.
    // Accepted selectors:
    // - layerName: "Exact Name"
    // - layerNames: ["Name A", "Name B"]
    // - layerName: "selected" OR useSelectedLayers/applyToSelected/selected: true
    // If no explicit selector is given, selected layers are used when available.
    function agentResolveTargetLayers(comp, args, context, compName) {
        var result = { ok: false, layers: [], mode: "", msg: "" };
        if (!comp) { result.msg = "comp not found."; return result; }

        args = args || {};
        var names = [];
        var missingNames = [];
        var useSelected = false;

        function addName(raw) {
            if (raw === undefined || raw === null) return;
            var n = String(raw).replace(/^\s+|\s+$/g, "");
            if (n === "") return;

            var lower = n.toLowerCase();
            if (lower === "selected" || lower === "selection" || lower === "selected layer" ||
                lower === "selected layers" || lower === "active selection" || lower === "current selection") {
                useSelected = true;
                return;
            }

            if (n.indexOf(",") !== -1 || n.indexOf(";") !== -1) {
                var parts = n.split(/[,;]+/);
                for (var pi = 0; pi < parts.length; pi++) addName(parts[pi]);
                return;
            }

            for (var ni = 0; ni < names.length; ni++) {
                if (names[ni] === n) return;
            }
            names.push(n);
        }

        if (args.layerNames instanceof Array) {
            for (var ln = 0; ln < args.layerNames.length; ln++) addName(args.layerNames[ln]);
        }
        if (args.layerName instanceof Array) {
            for (var la = 0; la < args.layerName.length; la++) addName(args.layerName[la]);
        } else {
            addName(args.layerName);
        }

        if (args.useSelectedLayers === true || args.applyToSelected === true || args.selected === true) {
            useSelected = true;
        }
        if (typeof args.target === "string" && args.target.toLowerCase().indexOf("selected") !== -1) {
            useSelected = true;
        }

        var seen = {};
        function pushLayer(layer) {
            if (!layer) return;
            try {
                var k = String(layer.index) + "|" + String(layer.name);
                if (seen[k]) return;
                seen[k] = true;
                result.layers.push(layer);
            } catch (e) { }
        }

        if (names.length > 0) {
            for (var i = 0; i < names.length; i++) {
                var found = agentFindLayer(comp, names[i], context, compName);
                if (found) pushLayer(found);
                else missingNames.push(names[i]);
            }
            if (result.layers.length === 0) {
                result.msg = "no matching layers found for: " + agentShortList(missingNames, 6);
                return result;
            }
            result.ok = true;
            result.mode = "named";
            if (missingNames.length > 0) {
                result.msg = "Some layer names were not found: " + agentShortList(missingNames, 4);
            }
            return result;
        }

        var selectedLayers = [];
        try {
            if (comp.selectedLayers && comp.selectedLayers.length > 0) {
                for (var si = 0; si < comp.selectedLayers.length; si++) {
                    selectedLayers.push(comp.selectedLayers[si]);
                }
            }
        } catch (selErr) { }

        if (useSelected || selectedLayers.length > 0) {
            if (selectedLayers.length === 0) {
                result.msg = "no selected layers in comp '" + comp.name + "'.";
                return result;
            }
            for (var sl = 0; sl < selectedLayers.length; sl++) pushLayer(selectedLayers[sl]);
            if (result.layers.length === 0) {
                result.msg = "selected layers are unavailable.";
                return result;
            }
            result.ok = true;
            result.mode = useSelected ? "selected" : "selected-fallback";
            return result;
        }

        if (context && context.lastLayer) {
            try {
                var lastLayer = context.lastLayer;
                var sameComp = false;
                if (lastLayer.containingComp && lastLayer.containingComp === comp) {
                    sameComp = true;
                } else if (lastLayer.index && lastLayer.index >= 1 && lastLayer.index <= comp.numLayers) {
                    var probe = comp.layer(lastLayer.index);
                    if (probe && probe.name === lastLayer.name) sameComp = true;
                }
                if (sameComp) {
                    pushLayer(lastLayer);
                    if (result.layers.length > 0) {
                        result.ok = true;
                        result.mode = "last-layer";
                        return result;
                    }
                }
            } catch (lastErr) { }
        }

        result.msg = "no target layer specified. Provide layerName/layerNames or select layer(s).";
        return result;
    }

    function agentNormalizeColor(c) {
        // Accept [R,G,B] or [R,G,B,A] in 0-1 or 0-255. Always return [R,G,B,A] 0-1.
        if (!c || c.length < 3) return [1, 1, 1, 1];
        var r = c[0], g = c[1], b = c[2], a = (c[3] !== undefined) ? c[3] : 1;
        // Detect 0-255 range: check RGB channels first, then check alpha independently.
        // Bug note: the old code only rescaled alpha when r>1||g>1||b>1, meaning
        // pure black [0,0,0,255] would leave alpha=255 unchanged — an invalid AE color.
        var rgbIs255 = (r > 1 || g > 1 || b > 1);
        if (rgbIs255) { r = r / 255; g = g / 255; b = b / 255; }
        // Alpha is rescaled independently: if the caller passed it in 0-255 space
        // (either alongside 0-255 RGB, or explicitly as a large value), normalise it.
        if (a > 1) a = a / 255;
        // Clamp to valid range after normalisation
        r = Math.max(0, Math.min(1, r));
        g = Math.max(0, Math.min(1, g));
        b = Math.max(0, Math.min(1, b));
        a = Math.max(0, Math.min(1, a));
        return [r, g, b, a];
    }

    function agentClampNumber(v, minV, maxV, fallback) {
        var n = parseFloat(v);
        if (isNaN(n)) n = (fallback !== undefined) ? fallback : minV;
        if (n < minV) n = minV;
        if (n > maxV) n = maxV;
        return n;
    }

    function agentAdaptVectorForProperty(inputVal, currentVal) {
        if (!(currentVal instanceof Array)) return inputVal;
        var out = currentVal.slice(0);
        if (inputVal instanceof Array) {
            for (var i = 0; i < out.length && i < inputVal.length; i++) out[i] = inputVal[i];
            return out;
        }
        var scalar = parseFloat(inputVal);
        if (isNaN(scalar)) scalar = out[0];
        for (var j = 0; j < out.length; j++) out[j] = scalar;
        return out;
    }

    function agentFindTransformProp(layer, propName) {
        if (!layer || propName === undefined || propName === null) return null;
        // Normalise: lowercase, strip spaces
        var key = propName.toLowerCase().replace(/\s+/g, "");
        var matchNameMap = {
            "position":       "ADBE Position",
            "xposition":      "ADBE Position_0",   // separated position x
            "yposition":      "ADBE Position_1",   // separated position y
            "zposition":      "ADBE Position_2",   // separated position z
            "scale":          "ADBE Scale",
            "rotation":       "ADBE Rotate Z",     // 2D rotation
            "rotatez":        "ADBE Rotate Z",
            "rotationz":      "ADBE Rotate Z",
            "zrotation":      "ADBE Rotate Z",
            "rotatex":        "ADBE Rotate X",
            "rotationx":      "ADBE Rotate X",
            "xrotation":      "ADBE Rotate X",
            "rotatey":        "ADBE Rotate Y",
            "rotationy":      "ADBE Rotate Y",
            "yrotation":      "ADBE Rotate Y",
            "orientation":    "ADBE Orientation",
            "opacity":        "ADBE Opacity",
            "anchorpoint":    "ADBE Anchor Point"
        };
        var matchName = matchNameMap[key];
        try {
            var xform = layer.property("ADBE Transform Group");
            if (matchName && xform) {
                var p = xform.property(matchName);
                if (p) return p;
            }
            // Friendly display-name fallback (handles e.g. "Rotation", "Opacity" as passed by AI)
            var friendlyMap = {
                "position": "Position", "scale": "Scale",
                "rotation": "Rotation", "rotatez": "Rotation", "rotationz": "Rotation",
                "rotatex": "X Rotation", "rotationx": "X Rotation", "xrotation": "X Rotation",
                "rotatey": "Y Rotation", "rotationy": "Y Rotation", "yrotation": "Y Rotation",
                "orientation": "Orientation",
                "opacity": "Opacity",
                "anchorpoint": "Anchor Point"
            };
            var fname = friendlyMap[key];
            if (fname && xform) {
                var fp = xform.property(fname);
                if (fp) return fp;
            }
        } catch (e) { }
        return null;
    }

    // --- TOOL: createComposition ---
    // args: { name, width, height, duration, frameRate, pixelAspect, bgColor }
    function agentTool_createComposition(args, context) {
        var name = args.name || "Agent Comp";
        var width = parseInt(args.width, 10); if (isNaN(width) || width < 4) width = 1920;
        var height = parseInt(args.height, 10); if (isNaN(height) || height < 4) height = 1080;
        var duration = parseFloat(args.duration); if (isNaN(duration) || duration <= 0) duration = 10;
        var frameRate = parseFloat(args.frameRate); if (isNaN(frameRate) || frameRate <= 0) frameRate = 30;
        var pxAspect = parseFloat(args.pixelAspect); if (isNaN(pxAspect) || pxAspect <= 0) pxAspect = 1;
        var bgColor = agentNormalizeColor(args.bgColor || [0, 0, 0, 1]);

        try {
            var comp = app.project.items.addComp(name, width, height, pxAspect, duration, frameRate);
            comp.bgColor = [bgColor[0], bgColor[1], bgColor[2]];
            context.comps[name] = comp;
            context.lastComp = comp;
            comp.openInViewer();
            return { ok: true, msg: "Created comp '" + name + "' " + width + "x" + height + " @ " + frameRate + "fps, " + duration + "s" };
        } catch (e) {
            return { ok: false, msg: "createComposition failed: " + e.toString() };
        }
    }

    // --- TOOL: createSolidLayer ---
    // args: { compName, name, color, width, height, duration }
    function agentTool_createSolidLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "createSolidLayer: comp '" + args.compName + "' not found." };

        var name = args.name || "Solid";
        var color = agentNormalizeColor(args.color || [1, 0, 0, 1]);
        var width = parseInt(args.width, 10); if (isNaN(width) || width < 1) width = comp.width;
        var height = parseInt(args.height, 10); if (isNaN(height) || height < 1) height = comp.height;
        var dur = parseFloat(args.duration); if (isNaN(dur) || dur <= 0) dur = comp.duration;

        try {
            var layer = comp.layers.addSolid([color[0], color[1], color[2]], name, width, height, 1, dur);
            var cKey = (args.compName || comp.name) + "|" + name;
            context.layers[cKey] = layer;
            context.lastLayer = layer;
            return { ok: true, msg: "Created solid '" + name + "' in '" + comp.name + "'" };
        } catch (e) {
            return { ok: false, msg: "createSolidLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: createTextLayer ---
    // args: { compName, name, text, fontSize, fontName, color, position, alignment, bold, italic }
    function agentTool_createTextLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "createTextLayer: comp '" + args.compName + "' not found." };
        if (!args.text && args.text !== 0) {
            args.text = (args.name && args.name !== "") ? args.name : "Text";
        }

        try {
            var layer = comp.layers.addText(args.text.toString());
            var lName = args.name || ("Text: " + args.text.toString().substr(0, 20));
            layer.name = lName;

            var textDoc = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
            if (args.fontSize) textDoc.fontSize = args.fontSize;
            if (args.fontName) {
                try { textDoc.font = args.fontName; } catch (fe) { /* font not installed, skip */ }
            }
            if (args.color) {
                var c = agentNormalizeColor(args.color);
                textDoc.fillColor = [c[0], c[1], c[2]];
                textDoc.applyFill = true;
            }
            if (args.bold !== undefined) textDoc.bold = args.bold;
            if (args.italic !== undefined) textDoc.italic = args.italic;
            // Justification
            if (args.alignment) {
                var al = args.alignment.toLowerCase();
                if (al === "center") textDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
                else if (al === "right") textDoc.justification = ParagraphJustification.RIGHT_JUSTIFY;
                else textDoc.justification = ParagraphJustification.LEFT_JUSTIFY;
            }
            layer.property("ADBE Text Properties").property("ADBE Text Document").setValue(textDoc);

            if (args.position) {
                layer.transform.position.setValue(args.position);
            }

            var cKey = (args.compName || comp.name) + "|" + lName;
            context.layers[cKey] = layer;
            context.lastLayer = layer;
            return { ok: true, msg: "Created text layer '" + lName + "' with text: " + args.text };
        } catch (e) {
            return { ok: false, msg: "createTextLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: createShapeLayer ---
    // args: { compName, name, shapeType, size, position, fillColor, strokeColor, strokeWidth, cornerRadius }
    // shapeType: "rectangle" | "ellipse" | "polygon" | "star"
    function agentTool_createShapeLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "createShapeLayer: comp '" + args.compName + "' not found." };

        var name = args.name || "Shape Layer";
        var shapeType = (args.shapeType || "rectangle").toLowerCase();
        var size = args.size || [200, 200];
        var fillColor = agentNormalizeColor(args.fillColor || [1, 1, 1, 1]);
        var strokeColor = agentNormalizeColor(args.strokeColor || [0, 0, 0, 1]);
        var strokeWidth = (args.strokeWidth !== undefined) ? args.strokeWidth : 0;

        try {
            var layer = comp.layers.addShape();
            layer.name = name;

            var contents = layer.property("ADBE Root Vectors Group");
            var grp = contents.addProperty("ADBE Vector Group");
            grp.name = shapeType.charAt(0).toUpperCase() + shapeType.slice(1) + " Group";
            var grpContents = grp.property("ADBE Vectors Group");

            // Add shape
            if (shapeType === "ellipse") {
                var ellipse = grpContents.addProperty("ADBE Vector Shape - Ellipse");
                ellipse.property("ADBE Vector Ellipse Size").setValue(size);
            } else if (shapeType === "polygon") {
                var poly = grpContents.addProperty("ADBE Vector Shape - Star");
                poly.property("ADBE Vector Star Type").setValue(1); // polygon
                poly.property("ADBE Vector Star Points").setValue(args.points || 6);
                poly.property("ADBE Vector Star OR").setValue(size[0] / 2);
            } else if (shapeType === "star") {
                var star = grpContents.addProperty("ADBE Vector Shape - Star");
                star.property("ADBE Vector Star Type").setValue(2); // star
                star.property("ADBE Vector Star Points").setValue(args.points || 5);
                star.property("ADBE Vector Star OR").setValue(size[0] / 2);
                star.property("ADBE Vector Star IR").setValue((size[0] / 2) * 0.45);
            } else {
                // Rectangle (default)
                var rect = grpContents.addProperty("ADBE Vector Shape - Rect");
                rect.property("ADBE Vector Rect Size").setValue(size);
                if (args.cornerRadius) {
                    rect.property("ADBE Vector Rect Roundness").setValue(args.cornerRadius);
                }
            }

            // Fill
            var fill = grpContents.addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").setValue(fillColor);

            // Stroke (only if width > 0)
            if (strokeWidth > 0) {
                var stroke = grpContents.addProperty("ADBE Vector Graphic - Stroke");
                stroke.property("ADBE Vector Stroke Color").setValue(strokeColor);
                stroke.property("ADBE Vector Stroke Width").setValue(strokeWidth);
            }

            if (args.position) {
                layer.transform.position.setValue(args.position);
            }

            var cKey = (args.compName || comp.name) + "|" + name;
            context.layers[cKey] = layer;
            context.lastLayer = layer;
            return { ok: true, msg: "Created " + shapeType + " shape layer '" + name + "' in '" + comp.name + "'" };
        } catch (e) {
            return { ok: false, msg: "createShapeLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: createNullLayer ---
    // args: { compName, name, position, size }
    function agentTool_createNullLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "createNullLayer: comp '" + args.compName + "' not found." };
        var name = args.name || "Null";
        try {
            var layer = comp.layers.addNull(comp.duration);
            layer.name = name;
            if (args.position !== undefined) layer.transform.position.setValue(agentAdaptVectorForProperty(args.position, layer.transform.position.value));
            var cKey = (args.compName || comp.name) + "|" + name;
            context.layers[cKey] = layer;
            context.lastLayer = layer;
            return { ok: true, msg: "Created null layer '" + name + "'" };
        } catch (e) {
            return { ok: false, msg: "createNullLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: createCameraLayer ---
    // args: { compName, name, type, fov, position }
    // type: "one-node" | "two-node"
    function agentTool_createCameraLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "createCameraLayer: comp '" + args.compName + "' not found." };
        var name = args.name || "Camera";
        var type = String(args.type || "two-node").toLowerCase();
        var fov = agentClampNumber((args.fov !== undefined) ? args.fov : 75, 1, 179, 75);
        try {
            var layer = comp.layers.addCamera(name, [comp.width / 2, comp.height / 2]);
            // AE uses mm focal length not FOV, so approximate: focal = width / (2 * tan(fov/2 in radians))
            var focal = comp.width / (2 * Math.tan((fov * Math.PI / 180) / 2));
            layer.cameraOption.focalLength.setValue(focal);
            // Approximate one-node vs two-node behavior via auto-orient.
            try {
                if (type === "one-node") layer.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
                else layer.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
            } catch (aoErr) { }
            if (args.position !== undefined) layer.transform.position.setValue(agentAdaptVectorForProperty(args.position, layer.transform.position.value));
            var cKey = (args.compName || comp.name) + "|" + name;
            context.layers[cKey] = layer;
            context.lastLayer = layer;
            return { ok: true, msg: "Created " + type + " camera '" + name + "'" };
        } catch (e) {
            return { ok: false, msg: "createCameraLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: createLightLayer ---
    // args: { compName, name, lightType, color, intensity, position }
    // lightType: "parallel" | "spot" | "point" | "ambient"
    function agentTool_createLightLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "createLightLayer: comp '" + args.compName + "' not found." };
        var name = args.name || "Light";
        var lTypeStr = String(args.lightType || "point").toLowerCase();
        var lTypeMap = { "parallel": LightType.PARALLEL, "spot": LightType.SPOT, "point": LightType.POINT, "ambient": LightType.AMBIENT };
        var lType = lTypeMap[lTypeStr] || LightType.POINT;
        try {
            var layer = comp.layers.addLight(name, [comp.width / 2, comp.height / 2]);
            layer.lightOption.lightType.setValue(lType);
            if (args.color) {
                var c = agentNormalizeColor(args.color);
                layer.lightOption.color.setValue([c[0], c[1], c[2]]);
            }
            if (args.intensity !== undefined) layer.lightOption.intensity.setValue(args.intensity);
            if (args.position !== undefined) layer.transform.position.setValue(agentAdaptVectorForProperty(args.position, layer.transform.position.value));
            var cKey = (args.compName || comp.name) + "|" + name;
            context.layers[cKey] = layer;
            context.lastLayer = layer;
            return { ok: true, msg: "Created " + lTypeStr + " light '" + name + "'" };
        } catch (e) {
            return { ok: false, msg: "createLightLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: setLayerProperties ---
    // args: { compName, layerName, position, scale, rotation, opacity, anchorPoint, inPoint, outPoint, is3DLayer, blendMode, motionBlur }
    function agentTool_setLayerProperties(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setLayerProperties: comp not found." };
        if (!args.layerName && context && context.lastLayer) args.layerName = context.lastLayer.name;
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "setLayerProperties: layer '" + args.layerName + "' not found." };

        var changed = [];
        try {
            // Apply dimensional mode first so vector properties match intended 2D/3D arity.
            if (args.is3DLayer !== undefined) { layer.threeDLayer = args.is3DLayer; changed.push("3D"); }

            // Helper: use setValueAtTime when keyframes already exist on a property
            // to avoid the AE "Can not call setValue() on a property with keyframes" error.
            function safeSet(prop, value) {
                if (prop.numKeys && prop.numKeys > 0) {
                    // Use workAreaStart (typically 0) instead of comp.time — keying at the
                    // current playhead position creates a keyframe mid-comp when the user
                    // has scrubbed away from frame 0, leaving the property at its default
                    // before that point.
                    prop.setValueAtTime(comp.workAreaStart || 0, value);
                } else {
                    prop.setValue(value);
                }
            }

            if (args.position !== undefined) {
                var curPos = layer.transform.position.value;
                safeSet(layer.transform.position, agentAdaptVectorForProperty(args.position, curPos));
                agentRememberProperty(context, args.compName || comp.name, layer.name, "position");
                changed.push("position");
            }
            if (args.scale !== undefined) {
                var curScale = layer.transform.scale.value;
                safeSet(layer.transform.scale, agentAdaptVectorForProperty(args.scale, curScale));
                agentRememberProperty(context, args.compName || comp.name, layer.name, "scale");
                changed.push("scale");
            }
            if (args.rotation !== undefined) {
                safeSet(layer.transform.rotation, args.rotation);
                agentRememberProperty(context, args.compName || comp.name, layer.name, "rotation");
                changed.push("rotation");
            }
            if (args.opacity !== undefined) {
                safeSet(layer.transform.opacity, args.opacity);
                agentRememberProperty(context, args.compName || comp.name, layer.name, "opacity");
                changed.push("opacity");
            }
            if (args.anchorPoint !== undefined) {
                var curAnc = layer.transform.anchorPoint.value;
                safeSet(layer.transform.anchorPoint, agentAdaptVectorForProperty(args.anchorPoint, curAnc));
                agentRememberProperty(context, args.compName || comp.name, layer.name, "anchorPoint");
                changed.push("anchorPoint");
            }
            if (args.inPoint !== undefined) { layer.inPoint = args.inPoint; changed.push("inPoint"); }
            if (args.outPoint !== undefined) { layer.outPoint = args.outPoint; changed.push("outPoint"); }
            if (args.motionBlur !== undefined) { layer.motionBlur = args.motionBlur; changed.push("motionBlur"); }
            if (args.blendMode !== undefined) {
                var bModeMap = {
                    "normal": BlendingMode.NORMAL, "add": BlendingMode.ADD, "multiply": BlendingMode.MULTIPLY,
                    "screen": BlendingMode.SCREEN, "overlay": BlendingMode.OVERLAY, "darken": BlendingMode.DARKEN,
                    "lighten": BlendingMode.LIGHTEN, "colordodge": BlendingMode.COLOR_DODGE,
                    "colorburn": BlendingMode.COLOR_BURN, "hardlight": BlendingMode.HARD_LIGHT,
                    "softlight": BlendingMode.SOFT_LIGHT, "difference": BlendingMode.DIFFERENCE,
                    "exclusion": BlendingMode.EXCLUSION, "hue": BlendingMode.HUE,
                    "saturation": BlendingMode.SATURATION, "color": BlendingMode.COLOR,
                    "luminosity": BlendingMode.LUMINOSITY
                };
                var bmKey = String(args.blendMode).toLowerCase().replace(/\s/g, "");
                var bm = bModeMap[bmKey];
                if (bm !== undefined) { layer.blendingMode = bm; changed.push("blendMode"); }
            }
            return { ok: true, msg: "Set properties on '" + args.layerName + "': " + changed.join(", ") };
        } catch (e) {
            return { ok: false, msg: "setLayerProperties failed: " + e.toString() };
        }
    }

    // --- TOOL: addKeyframe ---
    // args: { compName, layerName, property, time, value, easeIn, easeOut }
    // property: "position"|"scale"|"rotation"|"opacity"|"anchorPoint"
    function agentTool_addKeyframe(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addKeyframe: comp not found." };
        if (!args.layerName && context && context.lastLayer) args.layerName = context.lastLayer.name;
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "addKeyframe: layer '" + args.layerName + "' not found." };
        if (args.property === undefined || args.property === null || args.property === "") {
            args.property = agentGuessProperty(context, args.compName || comp.name, args.layerName, "position");
        }
        if (args.time === undefined) return { ok: false, msg: "addKeyframe: 'time' is required (seconds)." };
        if (args.value === undefined) return { ok: false, msg: "addKeyframe: 'value' is required." };

        try {
            var prop = agentFindTransformProp(layer, args.property);
            // Fall back to direct property lookup for non-transform properties
            // (effect properties, Source Text, Trim Paths start/end, stroke width, etc.)
            if (!prop) {
                try { prop = layer.property(args.property); } catch (pe) { prop = null; }
            }
            if (!prop) prop = searchPropertyRecursive(layer, args.property);
            if (!prop) return { ok: false, msg: "addKeyframe: property '" + args.property + "' not found on layer '" + (args.layerName || "?") + "'. Check the property name matches what AE shows in the timeline." };

            var keyVal = agentAdaptVectorForProperty(args.value, prop.value);
            // If an expression is active on this property, disable it before keying.
            // Calling setValueAtTime on an expression-driven property creates a keyframe
            // that is immediately ignored (the expression overrides it), and can corrupt
            // the keyframe channel on certain properties in older AE versions.
            var hadExpression = false;
            var savedExpr = "";
            try {
                if (prop.expressionEnabled && prop.expression && prop.expression !== "") {
                    savedExpr = prop.expression;
                    hadExpression = true;
                    prop.expressionEnabled = false;
                }
            } catch (exprCheck) {}
            prop.setValueAtTime(args.time, keyVal);
            // Restore expression if we temporarily disabled it
            if (hadExpression && savedExpr !== "") {
                try {
                    prop.expression = savedExpr;
                    prop.expressionEnabled = true;
                } catch (exprRestore) {}
            }
            agentRememberProperty(context, args.compName || comp.name, layer.name, args.property);

            // Apply easing if requested
            if (args.easeIn || args.easeOut) {
                var kIdx = prop.nearestKeyIndex(args.time);
                var inInf = args.easeIn && args.easeIn.influence !== undefined ? args.easeIn.influence : 33.33;
                var outInf = args.easeOut && args.easeOut.influence !== undefined ? args.easeOut.influence : 33.33;
                if (inInf < 0.1) inInf = 0.1; if (inInf > 100) inInf = 100;
                if (outInf < 0.1) outInf = 0.1; if (outInf > 100) outInf = 100;
                var eIn = new KeyframeEase(args.easeIn && args.easeIn.speed !== undefined ? args.easeIn.speed : 0, inInf);
                var eOut = new KeyframeEase(args.easeOut && args.easeOut.speed !== undefined ? args.easeOut.speed : 0, outInf);
                agentApplyTemporalEaseAtKeySafe(prop, kIdx, eIn, eOut);
            }
            return { ok: true, msg: "Added keyframe on '" + args.property + "' at t=" + args.time + "s on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "addKeyframe failed: " + e.toString() };
        }
    }

    // --- TOOL: applyEffect ---
    // args: { compName, layerName, effectMatchName, effectDisplayName, properties }
    // properties: array of { index: N, value: V }  (1-based property indices)
    function agentTool_isTextAnimatorMatchName(effectMatchName) {
        if (!effectMatchName) return false;
        var upper = String(effectMatchName).toUpperCase();
        // Hard prefix guard
        if (upper.indexOf("ADBE TEXT") === 0) return true;

        // Explicit text animator/group blocklist
        var blocked = {
            "ADBE TEXT ANIMATOR": true,
            "ADBE TEXT ANIMATORS": true,
            "ADBE TEXT ANIMATOR PROPERTIES": true,
            "ADBE TEXT PROPERTIES": true,
            "ADBE TEXT SELECTOR": true,
            "ADBE TEXT SELECTORS": true,
            "ADBE TEXT FILL": true,
            "ADBE TEXT FILL COLOR": true,
            "ADBE TEXT FILL OPACITY": true,
            "ADBE TEXT STROKE": true,
            "ADBE TEXT STROKE COLOR": true,
            "ADBE TEXT STROKE OPACITY": true,
            "ADBE TEXT STROKE WIDTH": true,
            "ADBE TEXT OPACITY": true,
            "ADBE TEXT SCALE": true,
            "ADBE TEXT POSITION": true,
            "ADBE TEXT ROTATION": true,
            "ADBE TEXT TRACKING AMOUNT": true,
            "ADBE TEXT SHADOW": true
        };
        return !!blocked[upper];
    }

    function agentFindEffectOnLayer(layer, effectMatchName) {
        if (!layer || !effectMatchName) return null;
        try {
            var effects = layer.property("ADBE Effect Parade");
            if (!effects) return null;
            for (var e = 1; e <= effects.numProperties; e++) {
                var ef = effects.property(e);
                if (ef && (ef.matchName === effectMatchName || ef.name === effectMatchName)) {
                    return ef;
                }
            }
        } catch (e) { }
        return null;
    }

    function agentTool_applyEffect(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "applyEffect: comp not found." };
        if (!args.effectMatchName) return { ok: false, msg: "applyEffect: 'effectMatchName' is required." };

        try {
            // Text animator matchNames are NOT regular Effects panel effects.
            if (agentTool_isTextAnimatorMatchName(args.effectMatchName)) {
                return {
                    ok: false,
                    msg: "applyEffect blocked: '" + args.effectMatchName + "' is a text animator/text property matchName, not an effect. Use addTextAnimator instead."
                };
            }

            var targets = agentResolveTargetLayers(comp, args, context, args.compName);
            if (!targets.ok) return { ok: false, msg: "applyEffect: " + targets.msg };

            var successNames = [];
            var failNotes = [];
            for (var li = 0; li < targets.layers.length; li++) {
                var layer = targets.layers[li];
                try {
                    var effects = layer.property("ADBE Effect Parade");
                    if (!effects) {
                        failNotes.push(layer.name + " (effects group not found)");
                        continue;
                    }

                    // Reuse effect if already present, otherwise add it.
                    var effect = agentFindEffectOnLayer(layer, args.effectMatchName);
                    if (!effect) effect = effects.addProperty(args.effectMatchName);
                    if (args.effectDisplayName) effect.name = args.effectDisplayName;

                    if (args.properties && args.properties.length > 0) {
                        for (var pi = 0; pi < args.properties.length; pi++) {
                            var p = args.properties[pi];
                            var idx = parseInt(p.index, 10);
                            if (isNaN(idx) || idx < 1) idx = (pi + 1);
                            var val = p.value;
                            if (val instanceof Array && val.length >= 3) {
                                val = agentNormalizeColor(val);
                            }
                            try {
                                var efInitProp = effect.property(idx);
                                // Use comp.workAreaStart (typically 0) rather than comp.time —
                                // comp.time is the current playhead position. Keying at a random
                                // scrub position creates a keyframe in the middle of the comp,
                                // leaving the effect at its default value before that point.
                                if (efInitProp.numKeys && efInitProp.numKeys > 0) efInitProp.setValueAtTime(comp.workAreaStart || 0, val);
                                else efInitProp.setValue(val);
                            } catch (pe) { }
                        }
                    }
                    successNames.push(layer.name);
                } catch (layerErr) {
                    failNotes.push(layer.name + " (" + layerErr.toString() + ")");
                }
            }

            if (successNames.length === 0) {
                return { ok: false, msg: "applyEffect failed on all target layers: " + agentShortList(failNotes, 3) };
            }

            var msg = "Applied effect '" + args.effectMatchName + "' to " + successNames.length + " layer(s): " + agentShortList(successNames, 4);
            if (failNotes.length > 0) msg += ". Failed " + failNotes.length + ": " + agentShortList(failNotes, 2);
            if (targets.msg) msg += ". " + targets.msg;
            return { ok: true, msg: msg };
        } catch (e) {
            return { ok: false, msg: "applyEffect failed: " + e.toString() };
        }
    }

    // --- TOOL: applyExpression ---
    // args: { compName, layerName, property, expression }
    function agentTool_applyExpression(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "applyExpression: comp not found." };
        if (!args.layerName && context && context.lastLayer) args.layerName = context.lastLayer.name;
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "applyExpression: layer '" + args.layerName + "' not found." };
        if (!args.expression) return { ok: false, msg: "applyExpression: 'expression' is required." };
        if (!args.property) {
            var exprLower = String(args.expression || "").toLowerCase();
            if (exprLower.indexOf("sourcetext") !== -1 || exprLower.indexOf("text.source") !== -1) args.property = "Source Text";
            else args.property = agentGuessProperty(context, args.compName || comp.name, args.layerName, "position");
        }

        try {
            var prop = agentFindTransformProp(layer, args.property);
            if (!prop) {
                // Try direct lookup for non-transform properties
                prop = layer.property(args.property);
            }
            if (!prop) prop = searchPropertyRecursive(layer, args.property);
            if (!prop || !prop.canSetExpression) {
                return { ok: false, msg: "applyExpression: cannot set expression on '" + args.property + "'" };
            }
            var applyRes = setExpressionOnPropertySafely(prop, layer, args.expression);
            if (!applyRes.ok) return { ok: false, msg: "applyExpression: " + applyRes.msg };
            agentRememberProperty(context, args.compName || comp.name, layer.name, args.property);
            return { ok: true, msg: "Applied expression to '" + args.property + "' on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "applyExpression failed: " + e.toString() };
        }
    }

    // --- TOOL: setLayerParent ---
    // args: { compName, childLayerName, parentLayerName }
    // Set parentLayerName to null to detach
    function agentTool_setLayerParent(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setLayerParent: comp not found." };
        // Do NOT fall back to lastLayer — both child and parent names must be explicit.
        // Guessing the child causes silent detaches on wrong layers.
        if (!args.childLayerName || String(args.childLayerName).replace(/^\s+|\s+$/g, "") === "") {
            return { ok: false, msg: "setLayerParent: childLayerName is required. Pass the exact layer name to parent." };
        }
        var child = agentFindLayer(comp, args.childLayerName, context, args.compName);
        if (!child) return { ok: false, msg: "setLayerParent: child layer '" + args.childLayerName + "' not found in comp. Check the snapshot for exact layer names." };
        try {
            if (!args.parentLayerName) {
                child.parent = null;
                return { ok: true, msg: "Detached '" + args.childLayerName + "' from parent." };
            }
            var parent = agentFindLayer(comp, args.parentLayerName, context, args.compName);
            if (!parent) return { ok: false, msg: "setLayerParent: parent layer '" + args.parentLayerName + "' not found." };
            if (parent === child) return { ok: false, msg: "setLayerParent: child and parent cannot be the same layer." };
            child.parent = parent;
            return { ok: true, msg: "Parented '" + args.childLayerName + "' to '" + args.parentLayerName + "'" };
        } catch (e) {
            return { ok: false, msg: "setLayerParent failed: " + e.toString() };
        }
    }

    // --- TOOL: duplicateLayer ---
    // args: { compName, layerName, newName }
    function agentTool_duplicateLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "duplicateLayer: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "duplicateLayer: layer '" + args.layerName + "' not found." };
        try {
            var dup = layer.duplicate();
            var newName = args.newName || (args.layerName + " copy");
            dup.name = newName;
            var cKey = (args.compName || comp.name) + "|" + newName;
            if (context && context.layers) context.layers[cKey] = dup;
            if (context) context.lastLayer = dup;
            return { ok: true, msg: "Duplicated '" + args.layerName + "' as '" + newName + "'" };
        } catch (e) {
            return { ok: false, msg: "duplicateLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: deleteLayer ---
    // args: { compName, layerName }
    function agentTool_deleteLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "deleteLayer: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "deleteLayer: layer '" + args.layerName + "' not found." };
        try {
            var cKey = (args.compName || comp.name) + "|" + args.layerName;
            layer.remove();
            if (context && context.layers) delete context.layers[cKey];
            // Clear lastLayer if it pointed to the now-deleted layer
            if (context && context.lastLayer) {
                try {
                    var lastName = context.lastLayer.name;
                    if (lastName === args.layerName) context.lastLayer = null;
                } catch (delLast) { context.lastLayer = null; }
            }
            return { ok: true, msg: "Deleted layer '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "deleteLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: renameLayer ---
    // args: { compName, layerName, newName }
    function agentTool_renameLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "renameLayer: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "renameLayer: layer '" + args.layerName + "' not found." };
        try {
            var oldKey = (args.compName || comp.name) + "|" + args.layerName;
            layer.name = args.newName;
            var newKey = (args.compName || comp.name) + "|" + args.newName;
            if (context && context.layers) {
                context.layers[newKey] = layer;
                delete context.layers[oldKey];
            }
            return { ok: true, msg: "Renamed '" + args.layerName + "' to '" + args.newName + "'" };
        } catch (e) {
            return { ok: false, msg: "renameLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: precomposeLayer ---
    // args: { compName, layerNames, newCompName, moveAllAttributes }
    function agentTool_precomposeLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "precomposeLayer: comp not found." };
        if (!args.layerNames || args.layerNames.length === 0) {
            return { ok: false, msg: "precomposeLayer: 'layerNames' array is required." };
        }
        try {
            // Build array of 1-based layer indices
            var indices = [];
            for (var i = 0; i < args.layerNames.length; i++) {
                var lyr = agentFindLayer(comp, args.layerNames[i], context, args.compName);
                if (lyr) indices.push(lyr.index);
            }
            if (indices.length === 0) return { ok: false, msg: "precomposeLayer: none of the named layers were found." };

            // ── PHASE 1: Capture pre-precompose layer state ─────────────────────
            // precompose() creates a new layer in the parent comp whose attributes
            // (blend mode, parent, track matte, label, etc.) are reset to defaults.
            // Save the top-most target layer's state so we can restore it after.
            // (Technique from Essentially.jsx by Jake In Motion)
            var topIndex = indices[0];
            for (var ti = 1; ti < indices.length; ti++) {
                if (indices[ti] < topIndex) topIndex = indices[ti];
            }
            var topLayer = comp.layer(topIndex);
            var savedState = null;
            try {
                savedState = {
                    name:               topLayer.name,
                    label:              topLayer.label,
                    blendingMode:       topLayer.blendingMode,
                    solo:               topLayer.solo,
                    shy:                topLayer.shy,
                    threeDLayer:        topLayer.threeDLayer,
                    collapseTransformation: topLayer.collapseTransformation,
                    // NOTE: inPoint/outPoint intentionally NOT saved — after precompose()
                    // the resulting layer's duration is the precomp's full duration.
                    // Restoring the original layer's trim values would incorrectly re-trim
                    // the precomp layer, hiding frames that were only inside other source layers.
                    stretch:            topLayer.stretch,
                    trackMatteType:     topLayer.trackMatteType,
                    parent:             topLayer.parent  // may be null
                };
            } catch (saveErr) { savedState = null; }

            // ── PHASE 2: Precompose ─────────────────────────────────────────────
            var pcName = args.newCompName || "Precomp";
            var newComp = comp.layers.precompose(indices, pcName, args.moveAllAttributes !== false);
            context.comps[pcName] = newComp;
            context.lastComp = newComp;

            // ── PHASE 3: Restore the resulting precomp layer's attributes ───────
            // After precompose() the new layer sits at the top-most index position.
            // We restore visual/organisational attributes only — not timing.
            if (savedState) {
                try {
                    var newLayer = comp.layer(topIndex);
                    try { newLayer.label              = savedState.label; }              catch (e) {}
                    try { newLayer.blendingMode        = savedState.blendingMode; }       catch (e) {}
                    try { newLayer.solo               = savedState.solo; }               catch (e) {}
                    try { newLayer.shy                = savedState.shy; }                catch (e) {}
                    try { newLayer.threeDLayer        = savedState.threeDLayer; }        catch (e) {}
                    try { newLayer.collapseTransformation = savedState.collapseTransformation; } catch (e) {}
                    try { newLayer.stretch            = savedState.stretch; }            catch (e) {}
                    try { newLayer.trackMatteType     = savedState.trackMatteType; }     catch (e) {}
                    if (savedState.parent) {
                        try { newLayer.parent         = savedState.parent; }             catch (e) {}
                    }
                } catch (restoreErr) { /* non-fatal — precompose still succeeded */ }
            }

            return { ok: true, msg: "Precomposed " + indices.length + " layer(s) into '" + pcName + "' (layer attributes preserved)" };
        } catch (e) {
            return { ok: false, msg: "precomposeLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: addMarker ---
    // args: { compName, layerName, time, comment, duration, url }
    // If layerName is omitted, adds a composition marker.
    function agentTool_addMarker(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addMarker: comp not found." };
        if (args.time === undefined) return { ok: false, msg: "addMarker: 'time' is required." };
        try {
            var markerVal = new MarkerValue(args.comment || "");
            // MarkerValue.duration and .url were added in AE CS5.5 — guard against older hosts.
            if (args.duration) { try { markerVal.duration = args.duration; } catch (mdErr) {} }
            if (args.url)      { try { markerVal.url      = args.url;      } catch (muErr) {} }

            if (args.layerName) {
                var layer = agentFindLayer(comp, args.layerName, context, args.compName);
                if (!layer) return { ok: false, msg: "addMarker: layer '" + args.layerName + "' not found." };
                layer.property("ADBE Marker").setValueAtTime(args.time, markerVal);
                return { ok: true, msg: "Added marker at t=" + args.time + "s on layer '" + args.layerName + "'" };
            } else {
                comp.markerProperty.setValueAtTime(args.time, markerVal);
                return { ok: true, msg: "Added comp marker at t=" + args.time + "s: '" + (args.comment || "") + "'" };
            }
        } catch (e) {
            return { ok: false, msg: "addMarker failed: " + e.toString() };
        }
    }

    // --- TOOL: setCompSettings ---
    // args: { compName, duration, frameRate, width, height, bgColor, workAreaStart, workAreaDuration }
    function agentTool_setCompSettings(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setCompSettings: comp not found." };
        var changed = [];
        try {
            if (args.duration !== undefined) { comp.duration = args.duration; changed.push("duration"); }
            if (args.frameRate !== undefined) { comp.frameRate = args.frameRate; changed.push("frameRate"); }
            if (args.workAreaStart !== undefined) { comp.workAreaStart = args.workAreaStart; changed.push("workAreaStart"); }
            if (args.workAreaDuration !== undefined) { comp.workAreaDuration = args.workAreaDuration; changed.push("workAreaDuration"); }
            if (args.bgColor) {
                var c = agentNormalizeColor(args.bgColor);
                comp.bgColor = [c[0], c[1], c[2]];
                changed.push("bgColor");
            }
            if (args.width !== undefined || args.height !== undefined) {
                // Width/height can only be changed via the DOM's width/height properties which are read-only in scripting.
                // The only way is to use app.executeCommand or the settings dialog — we note this limitation.
                changed.push("(width/height are read-only on existing comps via scripting — skipped)");
            }
            return { ok: true, msg: "Updated comp '" + comp.name + "': " + changed.join(", ") };
        } catch (e) {
            return { ok: false, msg: "setCompSettings failed: " + e.toString() };
        }
    }

    // ============================================================
    // EXTENDED AGENT TOOLS — V3 ADDITIONS
    // ============================================================

    // --- TOOL: setKeyframeInterpolation ---
    // args: { compName, layerName, property, keyIndex, inType, outType, allKeys, inSpeed, outSpeed, inInfluence, outInfluence }
    // inType/outType: "linear"|"bezier"|"hold"|"easeIn"|"easeOut"|"auto"
    function agentTool_setKeyframeInterpolation(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setKeyframeInterpolation: comp not found." };
        if (!args.layerName && context && context.lastLayer) args.layerName = context.lastLayer.name;
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "setKeyframeInterpolation: layer not found." };
        if (!args.property) {
            args.property = agentGuessProperty(context, args.compName || comp.name, args.layerName, "position");
        }
        try {
            var prop = agentFindTransformProp(layer, args.property);
            if (!prop) prop = layer.property(args.property);
            if (!prop) prop = searchPropertyRecursive(layer, args.property);
            if (!prop) return { ok: false, msg: "setKeyframeInterpolation: property not found." };
            if (!prop.setInterpolationTypeAtKey || prop.numKeys === undefined) {
                return { ok: false, msg: "setKeyframeInterpolation: target is not a keyframe property." };
            }
            if (prop.numKeys < 1) return { ok: false, msg: "setKeyframeInterpolation: property has no keyframes." };

            var typeMap = {
                "linear": KeyframeInterpolationType.LINEAR,
                "bezier": KeyframeInterpolationType.BEZIER,
                "hold": KeyframeInterpolationType.HOLD,
                "easein": KeyframeInterpolationType.BEZIER,
                "easeout": KeyframeInterpolationType.BEZIER,
                "auto": KeyframeInterpolationType.BEZIER
            };
            var applyAllKeys = (args.allKeys === true || args.keyIndex === undefined || args.keyIndex === null);
            var keyIndices = [];
            if (applyAllKeys) {
                for (var kk = 1; kk <= prop.numKeys; kk++) keyIndices.push(kk);
            } else {
                var kIdx = args.keyIndex;
                if (kIdx < 1) kIdx = 1;
                if (kIdx > prop.numKeys) kIdx = prop.numKeys;
                keyIndices.push(kIdx);
            }

            var inType = (args.inType || "bezier").toLowerCase();
            var outType = (args.outType || "bezier").toLowerCase();
            var inT = typeMap[inType] || KeyframeInterpolationType.BEZIER;
            var outT = typeMap[outType] || KeyframeInterpolationType.BEZIER;

            var needsEase = (inType === "easein" || outType === "easeout" || inType === "auto" || outType === "auto");
            var inSpeed = (args.inSpeed !== undefined) ? args.inSpeed : 0;
            var outSpeed = (args.outSpeed !== undefined) ? args.outSpeed : 0;
            var inInf = (args.inInfluence !== undefined) ? args.inInfluence : 33.33;
            var outInf = (args.outInfluence !== undefined) ? args.outInfluence : 33.33;
            if (inInf < 0.1) inInf = 0.1; if (inInf > 100) inInf = 100;
            if (outInf < 0.1) outInf = 0.1; if (outInf > 100) outInf = 100;

            for (var ki = 0; ki < keyIndices.length; ki++) {
                var key = keyIndices[ki];
                prop.setInterpolationTypeAtKey(key, inT, outT);
                if (needsEase) {
                    var eIn = new KeyframeEase(inSpeed, inInf);
                    var eOut = new KeyframeEase(outSpeed, outInf);
                    agentApplyTemporalEaseAtKeySafe(prop, key, eIn, eOut);
                }
            }
            agentRememberProperty(context, args.compName || comp.name, layer.name, args.property);
            if (applyAllKeys) {
                return { ok: true, msg: "Set interpolation on all " + keyIndices.length + " key(s) of '" + args.property + "' on '" + args.layerName + "'" };
            }
            return { ok: true, msg: "Set interpolation on key " + keyIndices[0] + " of '" + args.property + "' on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "setKeyframeInterpolation failed: " + e.toString() };
        }
    }

    // --- TOOL: removeEffect ---
    // args: { compName, layerName|layerNames, useSelectedLayers, effectMatchName }
    function agentTool_removeEffect(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "removeEffect: comp not found." };
        if (!args.effectMatchName) return { ok: false, msg: "removeEffect: effectMatchName is required." };
        try {
            var targets = agentResolveTargetLayers(comp, args, context, args.compName);
            if (!targets.ok) return { ok: false, msg: "removeEffect: " + targets.msg };

            var successNames = [];
            var failNotes = [];
            for (var li = 0; li < targets.layers.length; li++) {
                var layer = targets.layers[li];
                var removed = false;
                try {
                    var effects = layer.property("ADBE Effect Parade");
                    if (!effects) {
                        failNotes.push(layer.name + " (effects group not found)");
                        continue;
                    }
                    for (var e = effects.numProperties; e >= 1; e--) {
                        var ef = effects.property(e);
                        if (ef.matchName === args.effectMatchName || ef.name === args.effectMatchName) {
                            ef.remove();
                            removed = true;
                            break;
                        }
                    }
                    if (removed) successNames.push(layer.name);
                    else failNotes.push(layer.name + " (effect not found)");
                } catch (layerErr) {
                    failNotes.push(layer.name + " (" + layerErr.toString() + ")");
                }
            }

            if (successNames.length === 0) {
                return { ok: false, msg: "removeEffect: effect '" + args.effectMatchName + "' not found on targets (" + agentShortList(failNotes, 3) + ")" };
            }
            var msg = "Removed effect '" + args.effectMatchName + "' from " + successNames.length + " layer(s): " + agentShortList(successNames, 4);
            if (failNotes.length > 0) msg += ". Missed " + failNotes.length + ": " + agentShortList(failNotes, 2);
            if (targets.msg) msg += ". " + targets.msg;
            return { ok: true, msg: msg };
        } catch (e) {
            return { ok: false, msg: "removeEffect failed: " + e.toString() };
        }
    }

    // --- TOOL: setEffectProperty ---
    // args: { compName, layerName|layerNames, useSelectedLayers, effectMatchName, properties: [{index, value}] }
    // Modifies properties on an already-applied effect
    function agentTool_setEffectProperty(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setEffectProperty: comp not found." };
        if (!args.effectMatchName) return { ok: false, msg: "setEffectProperty: effectMatchName is required." };
        if (!args.properties || args.properties.length === 0) return { ok: false, msg: "setEffectProperty: properties array is required." };
        try {
            var targets = agentResolveTargetLayers(comp, args, context, args.compName);
            if (!targets.ok) return { ok: false, msg: "setEffectProperty: " + targets.msg };

            var successNames = [];
            var failNotes = [];
            for (var li = 0; li < targets.layers.length; li++) {
                var layer = targets.layers[li];
                try {
                    var effect = agentFindEffectOnLayer(layer, args.effectMatchName);
                    if (!effect) {
                        failNotes.push(layer.name + " (effect not found)");
                        continue;
                    }
                    var changed = 0;
                    for (var pi = 0; pi < args.properties.length; pi++) {
                        var p = args.properties[pi];
                        var pIndex = parseInt(p.index, 10);
                        if (isNaN(pIndex) || pIndex < 1) pIndex = (pi + 1);
                        var val = p.value;
                        if (val instanceof Array && val.length >= 3) val = agentNormalizeColor(val);
                        var efProp = effect.property(pIndex);
                        try {
                            if (efProp.numKeys && efProp.numKeys > 0) efProp.setValueAtTime(comp.workAreaStart || 0, val);
                            else efProp.setValue(val);
                            changed++;
                        } catch (pe) { }
                    }
                    if (changed > 0) successNames.push(layer.name);
                    else failNotes.push(layer.name + " (no settable properties)");
                } catch (layerErr) {
                    failNotes.push(layer.name + " (" + layerErr.toString() + ")");
                }
            }
            if (successNames.length === 0) {
                return { ok: false, msg: "setEffectProperty: no effect properties were updated (" + agentShortList(failNotes, 3) + ")" };
            }
            var msg = "Updated effect '" + args.effectMatchName + "' on " + successNames.length + " layer(s): " + agentShortList(successNames, 4);
            if (failNotes.length > 0) msg += ". Missed " + failNotes.length + ": " + agentShortList(failNotes, 2);
            if (targets.msg) msg += ". " + targets.msg;
            return { ok: true, msg: msg };
        } catch (e) {
            return { ok: false, msg: "setEffectProperty failed: " + e.toString() };
        }
    }

    // --- TOOL: addEffectKeyframe ---
    // args: { compName, layerName|layerNames, useSelectedLayers, effectMatchName, propertyIndex, time, value }
    function agentTool_addEffectKeyframe(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addEffectKeyframe: comp not found." };
        if (!args.effectMatchName) return { ok: false, msg: "addEffectKeyframe: effectMatchName is required." };
        if (args.time === undefined) return { ok: false, msg: "addEffectKeyframe: time is required." };
        if (args.value === undefined) return { ok: false, msg: "addEffectKeyframe: value is required." };
        try {
            var targets = agentResolveTargetLayers(comp, args, context, args.compName);
            if (!targets.ok) return { ok: false, msg: "addEffectKeyframe: " + targets.msg };

            var pIdx = parseInt(args.propertyIndex, 10);
            if (isNaN(pIdx) || pIdx < 1) pIdx = 1;
            var val = args.value;
            if (val instanceof Array && val.length >= 3) val = agentNormalizeColor(val);

            var successNames = [];
            var failNotes = [];
            for (var li = 0; li < targets.layers.length; li++) {
                var layer = targets.layers[li];
                try {
                    var effect = agentFindEffectOnLayer(layer, args.effectMatchName);
                    if (!effect) {
                        failNotes.push(layer.name + " (effect not found)");
                        continue;
                    }
                    var prop = effect.property(pIdx);
                    if (!prop || !prop.setValueAtTime) {
                        failNotes.push(layer.name + " (property " + pIdx + " not keyframe-capable)");
                        continue;
                    }
                    prop.setValueAtTime(args.time, val);
                    successNames.push(layer.name);
                } catch (layerErr) {
                    failNotes.push(layer.name + " (" + layerErr.toString() + ")");
                }
            }

            if (successNames.length === 0) {
                return { ok: false, msg: "addEffectKeyframe: no keyframes were added (" + agentShortList(failNotes, 3) + ")" };
            }
            var msg = "Added effect keyframe on '" + args.effectMatchName + "' prop " + pIdx + " at t=" + args.time + "s for " + successNames.length + " layer(s): " + agentShortList(successNames, 4);
            if (failNotes.length > 0) msg += ". Missed " + failNotes.length + ": " + agentShortList(failNotes, 2);
            if (targets.msg) msg += ". " + targets.msg;
            return { ok: true, msg: msg };
        } catch (e) {
            return { ok: false, msg: "addEffectKeyframe failed: " + e.toString() };
        }
    }

    // --- TOOL: removeExpression ---
    // args: { compName, layerName, property }
    function agentTool_removeExpression(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "removeExpression: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "removeExpression: layer not found." };
        try {
            var prop = agentFindTransformProp(layer, args.property);
            if (!prop) prop = layer.property(args.property);
            if (!prop || !prop.canSetExpression) return { ok: false, msg: "removeExpression: property not found or cannot have expressions." };
            prop.expression = "";
            return { ok: true, msg: "Removed expression from '" + args.property + "' on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "removeExpression failed: " + e.toString() };
        }
    }

    // --- TOOL: setLayerLabel ---
    // args: { compName, layerName, label (1-16 integer) }
    // AE label colors: 1=None, 2=Red, 3=Yellow, 4=Aqua, 5=Pink, 6=Lavender, 7=Peach, 8=Sea Foam,
    //                  9=Blue, 10=Green, 11=Purple, 12=Orange, 13=Brown, 14=Fuchsia, 15=Cyan, 16=Sandstone
    function agentTool_setLayerLabel(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setLayerLabel: comp not found." };
        if (!args.layerName && context && context.lastLayer) args.layerName = context.lastLayer.name;
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "setLayerLabel: layer not found." };
        var labelMap = {
            "none": 0, "red": 1, "yellow": 2, "aqua": 3, "pink": 4, "lavender": 5,
            "peach": 6, "seafoam": 7, "blue": 8, "green": 9, "purple": 10, "orange": 11,
            "brown": 12, "fuchsia": 13, "cyan": 14, "sandstone": 15, "tan": 15
        };
        try {
            var lv = args.label;
            if (typeof lv === "string") lv = labelMap[lv.toLowerCase().replace(/\s/g, "")] || 0;
            lv = Math.round(agentClampNumber(lv, 0, 16, 0));
            layer.label = lv;
            return { ok: true, msg: "Set label " + lv + " on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "setLayerLabel failed: " + e.toString() };
        }
    }

    // --- TOOL: setLayerSolo ---
    // args: { compName, layerName, solo (bool) }
    function agentTool_setLayerSolo(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setLayerSolo: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "setLayerSolo: layer not found." };
        try {
            layer.solo = (args.solo !== false);
            return { ok: true, msg: "Set solo=" + layer.solo + " on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "setLayerSolo failed: " + e.toString() };
        }
    }

    // --- TOOL: setLayerEnabled ---
    // args: { compName, layerName, enabled (bool) }
    function agentTool_setLayerEnabled(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setLayerEnabled: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "setLayerEnabled: layer not found." };
        try {
            layer.enabled = (args.enabled !== false);
            return { ok: true, msg: "Set enabled=" + layer.enabled + " on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "setLayerEnabled failed: " + e.toString() };
        }
    }

    // --- TOOL: setLayerLocked ---
    // args: { compName, layerName, locked (bool) }
    function agentTool_setLayerLocked(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setLayerLocked: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "setLayerLocked: layer not found." };
        try {
            layer.locked = (args.locked !== false);
            return { ok: true, msg: "Set locked=" + layer.locked + " on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "setLayerLocked failed: " + e.toString() };
        }
    }

    // --- TOOL: reorderLayer ---
    // args: { compName, layerName, newIndex (1-based) }
    function agentTool_reorderLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "reorderLayer: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "reorderLayer: layer not found." };
        try {
            var requested = parseInt(args.newIndex, 10);
            if (isNaN(requested)) requested = layer.index;
            var newIdx = Math.max(1, Math.min(requested, comp.numLayers));
            if (newIdx === layer.index) {
                return { ok: true, msg: "'" + args.layerName + "' already at index " + newIdx };
            }
            // AE ExtendScript uses moveAfter/moveBefore, not moveToIndex
            if (newIdx === 1) {
                // Move to top: get the current top layer and move before it
                var topLayer = comp.layer(1);
                if (topLayer !== layer) layer.moveBefore(topLayer);
            } else {
                // Move after the layer currently at newIdx-1
                // When moving down, the target shifts; compensate
                var targetIdx = (newIdx > layer.index) ? newIdx : newIdx - 1;
                targetIdx = Math.max(1, Math.min(targetIdx, comp.numLayers));
                var targetLayer = comp.layer(targetIdx);
                if (targetLayer && targetLayer !== layer) {
                    if (newIdx > layer.index) {
                        layer.moveAfter(targetLayer);
                    } else {
                        layer.moveBefore(comp.layer(newIdx));
                    }
                }
            }
            return { ok: true, msg: "Moved '" + args.layerName + "' to index " + newIdx };
        } catch (e) {
            return { ok: false, msg: "reorderLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: trimLayer ---
    // args: { compName, layerName, inPoint, outPoint, offset (shift startTime) }
    function agentTool_trimLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "trimLayer: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "trimLayer: layer not found." };
        var changed = [];
        try {
            if (args.inPoint !== undefined) { layer.inPoint = args.inPoint; changed.push("inPoint=" + args.inPoint); }
            if (args.outPoint !== undefined) { layer.outPoint = args.outPoint; changed.push("outPoint=" + args.outPoint); }
            if (args.offset !== undefined) { layer.startTime = args.offset; changed.push("startTime=" + args.offset); }
            return { ok: true, msg: "Trimmed '" + args.layerName + "': " + changed.join(", ") };
        } catch (e) {
            return { ok: false, msg: "trimLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: splitLayer ---
    // args: { compName, layerName, splitTime }
    // Splits a layer at the given time. AE's split layer command (command ID 2158).
    function agentTool_splitLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "splitLayer: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "splitLayer: layer not found." };
        try {
            // Deselect all, select our layer, move CTI, split
            for (var i = 1; i <= comp.numLayers; i++) { comp.layer(i).selected = false; }
            layer.selected = true;
            var splitTime = (args.splitTime !== undefined) ? parseFloat(args.splitTime) : (comp.duration / 2);
            if (isNaN(splitTime)) splitTime = comp.duration / 2;
            var maxSplit = comp.duration - comp.frameDuration;
            if (maxSplit < 0) maxSplit = 0;
            splitTime = Math.max(0, Math.min(splitTime, maxSplit));
            var prevTime = comp.time; // Save CTI before moving it
            comp.time = splitTime;
            app.executeCommand(2158); // Split Layer command
            comp.time = prevTime; // Restore CTI so user's playhead doesn't jump
            return { ok: true, msg: "Split '" + args.layerName + "' at t=" + splitTime };
        } catch (e) {
            return { ok: false, msg: "splitLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: setCurrentTime ---
    // args: { compName, time (seconds) }
    // Moves the composition's current-time indicator (CTI / playhead)
    function agentTool_setCurrentTime(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setCurrentTime: comp not found." };
        try {
            var maxTime = comp.duration - comp.frameDuration;
            if (maxTime < 0) maxTime = 0;
            var reqTime = (args.time !== undefined) ? parseFloat(args.time) : 0;
            if (isNaN(reqTime)) reqTime = 0;
            comp.time = Math.max(0, Math.min(reqTime, maxTime));
            return { ok: true, msg: "Moved CTI to t=" + comp.time + "s in '" + comp.name + "'" };
        } catch (e) {
            return { ok: false, msg: "setCurrentTime failed: " + e.toString() };
        }
    }

    // --- TOOL: addAdjustmentLayer ---
    // args: { compName, name, inPoint, outPoint }
    function agentTool_addAdjustmentLayer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addAdjustmentLayer: comp not found." };
        var name = args.name || "Adjustment Layer";
        try {
            var layer = comp.layers.addSolid([1, 1, 1], name, comp.width, comp.height, 1, comp.duration);
            layer.adjustmentLayer = true;
            if (args.inPoint !== undefined) layer.inPoint = args.inPoint;
            if (args.outPoint !== undefined) layer.outPoint = args.outPoint;
            var cKey = (args.compName || comp.name) + "|" + name;
            context.layers[cKey] = layer;
            context.lastLayer = layer;
            return { ok: true, msg: "Created adjustment layer '" + name + "'" };
        } catch (e) {
            return { ok: false, msg: "addAdjustmentLayer failed: " + e.toString() };
        }
    }

    // --- TOOL: addTextAnimator ---
    // args: { compName, layerName, animatorType, rangeStart, rangeEnd, value }
    // animatorType: "opacity"|"scale"|"position"|"rotation"|"tracking"|"fill_color"
    function agentTool_addTextAnimator(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addTextAnimator: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "addTextAnimator: layer not found." };
        try {
            var textProp = layer.property("ADBE Text Properties");
            if (!textProp) return { ok: false, msg: "addTextAnimator: '" + args.layerName + "' is not a text layer." };
            var animators = textProp.property("ADBE Text Animators");
            if (!animators) return { ok: false, msg: "addTextAnimator: text animators group unavailable." };
            var animType = String(args.animatorType || "opacity").toLowerCase();
            if (animType === "shadow") {
                return { ok: false, msg: "addTextAnimator: 'shadow' is not a text animator property. Use applyEffect with 'ADBE Drop Shadow' for text shadow styling." };
            }

            var animator = animators.addProperty("ADBE Text Animator");
            animator.name = args.animatorType || "Animator";
            var animProps = animator.property("ADBE Text Animator Properties");
            var typeMap = {
                "opacity": "ADBE Text Opacity",
                "scale": "ADBE Text Scale",
                "position": "ADBE Text Position",
                "rotation": "ADBE Text Rotation",
                "tracking": "ADBE Text Tracking Amount",
                "fill": "ADBE Text Fill Color",
                "fill_color": "ADBE Text Fill Color",
                "fill_opacity": "ADBE Text Fill Opacity",
                "stroke": "ADBE Text Stroke Color",
                "stroke_color": "ADBE Text Stroke Color",
                "stroke_width": "ADBE Text Stroke Width",
                "stroke_opacity": "ADBE Text Stroke Opacity"
            };
            var matchName = typeMap[animType] || "ADBE Text Opacity";
            var prop = null;
            try {
                prop = animProps.addProperty(matchName);
            } catch (apErr) {
                try {
                    prop = animProps.addProperty("ADBE Text Opacity");
                    matchName = "ADBE Text Opacity";
                } catch (opErr) {
                    return { ok: false, msg: "addTextAnimator: unsupported animator type '" + args.animatorType + "'" };
                }
            }

            if (args.value !== undefined) {
                var val = args.value;
                if (matchName === "ADBE Text Fill Color" && val instanceof Array) val = agentNormalizeColor(val);
                try { prop.setValue(val); } catch (ve) { }
            }

            // Add a range selector
            var selectors = animator.property("ADBE Text Selectors");
            if (selectors) {
                var sel = selectors.addProperty("ADBE Text Selector");
                if (args.rangeStart !== undefined) {
                    var rs = args.rangeStart;
                    if (rs < 0) rs = 0; if (rs > 100) rs = 100;
                    try { sel.property("ADBE Text Percent Start").setValue(rs); } catch (re) { }
                }
                if (args.rangeEnd !== undefined) {
                    var reVal = args.rangeEnd;
                    if (reVal < 0) reVal = 0; if (reVal > 100) reVal = 100;
                    try { sel.property("ADBE Text Percent End").setValue(reVal); } catch (re2) { }
                }
            }

            return { ok: true, msg: "Added text animator '" + args.animatorType + "' to '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "addTextAnimator failed: " + e.toString() };
        }
    }

    // --- TOOL: updateTextContent ---
    // args: { compName, layerName, text, fontSize, color, bold, italic, alignment }
    function agentTool_updateTextContent(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "updateTextContent: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "updateTextContent: layer not found." };
        try {
            var textGroup = layer.property("ADBE Text Properties");
            if (!textGroup) return { ok: false, msg: "updateTextContent: '" + args.layerName + "' is not a text layer." };
            var textProp = textGroup.property("ADBE Text Document");
            if (!textProp) return { ok: false, msg: "updateTextContent: text document property not found." };
            var textDoc = textProp.value;
            if (args.text !== undefined) textDoc.text = args.text.toString();
            if (args.fontSize !== undefined) textDoc.fontSize = args.fontSize;
            if (args.bold !== undefined) textDoc.bold = args.bold;
            if (args.italic !== undefined) textDoc.italic = args.italic;
            if (args.color !== undefined) {
                var c = agentNormalizeColor(args.color);
                textDoc.fillColor = [c[0], c[1], c[2]];
                textDoc.applyFill = true;
            }
            if (args.alignment !== undefined) {
                var al = args.alignment.toLowerCase();
                if (al === "center") textDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
                else if (al === "right") textDoc.justification = ParagraphJustification.RIGHT_JUSTIFY;
                else textDoc.justification = ParagraphJustification.LEFT_JUSTIFY;
            }
            // Use setValueAtTime when keyframes exist to avoid AE "Can not call setValue() on a property with keyframes" error.
            if (textProp.numKeys && textProp.numKeys > 0) textProp.setValueAtTime(comp.workAreaStart || 0, textDoc);
            else textProp.setValue(textDoc);
            return { ok: true, msg: "Updated text content on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "updateTextContent failed: " + e.toString() };
        }
    }

    // --- TOOL: setAnchorAndPosition ---
    // args: { compName, layerName, anchorPreset }
    // anchorPreset: "topLeft"|"topCenter"|"topRight"|"centerLeft"|"center"|"centerRight"|"bottomLeft"|"bottomCenter"|"bottomRight"
    // Snaps the anchor point to a named position and re-positions the layer so it doesn't jump.
    function agentTool_setAnchorAndPosition(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setAnchorAndPosition: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "setAnchorAndPosition: layer not found." };
        try {
            var rect = layer.sourceRectAtTime(comp.time, false);
            var w = rect.width;
            var h = rect.height;
            var l = rect.left;
            var t = rect.top;
            var presetMap = {
                "topleft": [l, t],
                "topcenter": [l + w / 2, t],
                "topright": [l + w, t],
                "centerleft": [l, t + h / 2],
                "center": [l + w / 2, t + h / 2],
                "centerright": [l + w, t + h / 2],
                "bottomleft": [l, t + h],
                "bottomcenter": [l + w / 2, t + h],
                "bottomright": [l + w, t + h]
            };
            var key = (args.anchorPreset || "center").toLowerCase().replace(/\s/g, "");
            var newAnchor = presetMap[key] || presetMap["center"];
            // Current world position of the current anchor
            var oldAnchor = layer.transform.anchorPoint.value;
            var currentPos = layer.transform.position.value;
            // Delta in layer space
            var dx = newAnchor[0] - oldAnchor[0];
            var dy = newAnchor[1] - oldAnchor[1];
            // Use setValueAtTime when keyframes exist to avoid AE "Can not call setValue() on a property with keyframes" error.
            function safeSetAP(prop, value) {
                if (prop.numKeys && prop.numKeys > 0) prop.setValueAtTime(comp.workAreaStart || 0, value);
                else prop.setValue(value);
            }
            safeSetAP(layer.transform.anchorPoint, newAnchor);
            if (currentPos instanceof Array && currentPos.length > 2) {
                safeSetAP(layer.transform.position, [currentPos[0] + dx, currentPos[1] + dy, currentPos[2]]);
            } else {
                safeSetAP(layer.transform.position, [currentPos[0] + dx, currentPos[1] + dy]);
            }
            return { ok: true, msg: "Set anchor to '" + args.anchorPreset + "' on '" + args.layerName + "' without moving layer." };
        } catch (e) {
            return { ok: false, msg: "setAnchorAndPosition failed: " + e.toString() };
        }
    }

    // --- TOOL: alignLayersInComp ---
    // args: { compName, layerNames, alignTo, axis }
    // alignTo: "left"|"right"|"top"|"bottom"|"hcenter"|"vcenter"|"compCenter"
    // Aligns multiple layers relative to each other or the comp.
    function agentTool_alignLayersInComp(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "alignLayersInComp: comp not found." };
        if (!args.layerNames || args.layerNames.length === 0) return { ok: false, msg: "alignLayersInComp: layerNames required." };
        try {
            var layers = [];
            for (var i = 0; i < args.layerNames.length; i++) {
                var l = agentFindLayer(comp, args.layerNames[i], context, args.compName);
                if (l) layers.push(l);
            }
            if (layers.length === 0) return { ok: false, msg: "alignLayersInComp: no valid layers found." };
            var alignTo = (args.alignTo || "hcenter").toLowerCase();
            var moved = 0;
            var skipped = 0;

            for (var li = 0; li < layers.length; li++) {
                try {
                    var lyr = layers[li];
                    var pos = lyr.transform.position.value;
                    var is3D = (pos instanceof Array && pos.length > 2);
                    var nx = pos[0];
                    var ny = pos[1];
                    var rect = null;
                    try {
                        rect = lyr.sourceRectAtTime(comp.time, false);
                    } catch (rectErr) {
                        rect = null;
                    }

                    if (alignTo === "left") {
                        nx = rect ? (-rect.left) : 0;
                    } else if (alignTo === "right") {
                        nx = rect ? (comp.width - rect.left - rect.width) : comp.width;
                    } else if (alignTo === "hcenter") {
                        nx = rect ? (comp.width / 2 - rect.left - rect.width / 2) : (comp.width / 2);
                    } else if (alignTo === "top") {
                        ny = rect ? (-rect.top) : 0;
                    } else if (alignTo === "bottom") {
                        ny = rect ? (comp.height - rect.top - rect.height) : comp.height;
                    } else if (alignTo === "vcenter") {
                        ny = rect ? (comp.height / 2 - rect.top - rect.height / 2) : (comp.height / 2);
                    } else if (alignTo === "compcenter") {
                        nx = rect ? (comp.width / 2 - rect.left - rect.width / 2) : (comp.width / 2);
                        ny = rect ? (comp.height / 2 - rect.top - rect.height / 2) : (comp.height / 2);
                    }

                    var alignProp = lyr.transform.position;
                    var alignVal = is3D ? [nx, ny, pos[2]] : [nx, ny];
                    if (alignProp.numKeys && alignProp.numKeys > 0) {
                        alignProp.setValueAtTime(comp.workAreaStart || 0, alignVal);
                    } else {
                        alignProp.setValue(alignVal);
                    }
                    moved++;
                } catch (alignLayerErr) {
                    skipped++;
                }
            }
            if (moved === 0) return { ok: false, msg: "alignLayersInComp: failed to align all layers." };
            var skipMsg = skipped > 0 ? (" (" + skipped + " skipped)") : "";
            return { ok: true, msg: "Aligned " + moved + " layer(s) to '" + alignTo + "'" + skipMsg };
        } catch (e) {
            return { ok: false, msg: "alignLayersInComp failed: " + e.toString() };
        }
    }

    // --- TOOL: distributeLayersEvenly ---
    // args: { compName, layerNames, axis ("x"|"y"), margin }
    // Distributes layers at equal spacing along an axis.
    function agentTool_distributeLayersEvenly(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "distributeLayersEvenly: comp not found." };
        if (!args.layerNames || args.layerNames.length < 2) return { ok: false, msg: "distributeLayersEvenly: need at least 2 layers." };
        try {
            var layers = [];
            for (var i = 0; i < args.layerNames.length; i++) {
                var l = agentFindLayer(comp, args.layerNames[i], context, args.compName);
                if (l) layers.push(l);
            }
            if (layers.length < 2) return { ok: false, msg: "distributeLayersEvenly: need at least 2 valid layers." };
            var axis = (args.axis || "x").toLowerCase();
            if (axis !== "x" && axis !== "y") axis = "x";
            // Sort layers by current position on the axis
            layers.sort(function (a, b) {
                var pa = a.transform.position.value;
                var pb = b.transform.position.value;
                return (axis === "y" ? pa[1] - pb[1] : pa[0] - pb[0]);
            });
            var first = layers[0].transform.position.value;
            var last = layers[layers.length - 1].transform.position.value;
            var totalSpan = (axis === "y" ? last[1] - first[1] : last[0] - first[0]);
            var step = (layers.length > 1) ? totalSpan / (layers.length - 1) : 0;
            if (args.margin !== undefined) {
                var marginVal = parseFloat(args.margin);
                if (!isNaN(marginVal)) step = marginVal;
            }
            for (var li = 0; li < layers.length; li++) {
                var pos = layers[li].transform.position.value;
                var is3D = (pos instanceof Array && pos.length > 2);
                var distProp = layers[li].transform.position;
                var distVal = (axis === "y")
                    ? (is3D ? [pos[0], first[1] + li * step, pos[2]] : [pos[0], first[1] + li * step])
                    : (is3D ? [first[0] + li * step, pos[1], pos[2]] : [first[0] + li * step, pos[1]]);
                if (distProp.numKeys && distProp.numKeys > 0) {
                    distProp.setValueAtTime(comp.workAreaStart || 0, distVal);
                } else {
                    distProp.setValue(distVal);
                }
            }
            return { ok: true, msg: "Distributed " + layers.length + " layers evenly on " + axis + "-axis" };
        } catch (e) {
            return { ok: false, msg: "distributeLayersEvenly failed: " + e.toString() };
        }
    }

    // --- TOOL: groupLayersUnderNull ---
    // args: { compName, layerNames, nullName, position }
    // Creates a null, parents all listed layers to it — classic AE grouping pattern.
    function agentTool_groupLayersUnderNull(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "groupLayersUnderNull: comp not found." };
        if (!args.layerNames || args.layerNames.length === 0) return { ok: false, msg: "groupLayersUnderNull: layerNames required." };
        var nullName = args.nullName || "Group Null";
        try {
            var nullLayer = comp.layers.addNull(comp.duration);
            nullLayer.name = nullName;
            if (args.position !== undefined) nullLayer.transform.position.setValue(agentAdaptVectorForProperty(args.position, nullLayer.transform.position.value));
            var cKey = (args.compName || comp.name) + "|" + nullName;
            context.layers[cKey] = nullLayer;
            var count = 0;
            for (var i = 0; i < args.layerNames.length; i++) {
                var child = agentFindLayer(comp, args.layerNames[i], context, args.compName);
                if (child) { child.parent = nullLayer; count++; }
            }
            return { ok: true, msg: "Created null '" + nullName + "' and parented " + count + " layers to it." };
        } catch (e) {
            return { ok: false, msg: "groupLayersUnderNull failed: " + e.toString() };
        }
    }

    // --- TOOL: addShapePathKeyframe ---
    // args: { compName, layerName, groupName, time, points, inTangents, outTangents, closed }
    // Animates the path of a shape inside a shape layer.
    function agentTool_addShapePathKeyframe(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addShapePathKeyframe: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "addShapePathKeyframe: layer not found." };
        try {
            var contents = layer.property("ADBE Root Vectors Group");
            // Find the first path property in the first group or named group
            var grp = null;
            if (args.groupName) {
                for (var gi = 1; gi <= contents.numProperties; gi++) {
                    if (contents.property(gi).name === args.groupName) { grp = contents.property(gi); break; }
                }
            }
            if (!grp && contents.numProperties > 0) grp = contents.property(1);
            if (!grp) return { ok: false, msg: "addShapePathKeyframe: no shape group found." };

            var grpContents = grp.property("ADBE Vectors Group");
            var pathProp = null;
            for (var pi = 1; pi <= grpContents.numProperties; pi++) {
                var p = grpContents.property(pi);
                if (p.matchName === "ADBE Vector Shape" || p.matchName === "ADBE Vector Shape - Rect" ||
                    p.matchName === "ADBE Vector Shape - Ellipse" || p.matchName === "ADBE Vector Shape - Star") {
                    // Try to get the path sub-property for rect/ellipse
                    try {
                        var pathSub = p.property("ADBE Vector Shape");
                        if (pathSub && pathSub.setValueAtTime) { pathProp = pathSub; break; }
                    } catch (pe) { }
                    if (p && p.setValueAtTime) { pathProp = p; break; }
                }
            }
            if (!pathProp) return { ok: false, msg: "addShapePathKeyframe: no animatable path found." };

            var pts = args.points || [[0, 0], [100, 0], [100, 100], [0, 100]];
            var inT = args.inTangents || [];
            var outT = args.outTangents || [];
            var closed = (args.closed !== false);
            var newPath = new Shape();
            newPath.vertices = pts;
            if (inT.length > 0) {
                newPath.inTangents = inT;
            } else {
                var autoIn = [];
                for (var ati = 0; ati < pts.length; ati++) autoIn.push([0, 0]);
                newPath.inTangents = autoIn;
            }
            if (outT.length > 0) {
                newPath.outTangents = outT;
            } else {
                var autoOut = [];
                for (var ato = 0; ato < pts.length; ato++) autoOut.push([0, 0]);
                newPath.outTangents = autoOut;
            }
            newPath.closed = closed;
            pathProp.setValueAtTime(args.time || 0, newPath);
            return { ok: true, msg: "Added shape path keyframe at t=" + (args.time || 0) + "s" };
        } catch (e) {
            return { ok: false, msg: "addShapePathKeyframe failed: " + e.toString() };
        }
    }

    // --- TOOL: addGradientFill ---
    // args: { compName, layerName, groupName, startColor, endColor, startPoint, endPoint, type }
    // type: "linear"|"radial"
    // NOTE: This tool only works on Shape layers (vector content group).
    // For solid/text/footage/adjustment layers, use applyEffect with "ADBE Ramp" instead.
    function agentTool_addGradientFill(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addGradientFill: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "addGradientFill: layer not found." };

        // Guard: addGradientFill only works on Shape layers (ShapeLayer type).
        // On solids, text, footage, or adjustment layers it would throw because
        // those don't have the "ADBE Root Vectors Group" property.
        // Redirect the caller to applyEffect + ADBE Ramp for those layer types.
        var isShapeLayer = false;
        try { isShapeLayer = (layer instanceof ShapeLayer); } catch (shErr) {}
        if (!isShapeLayer) {
            return {
                ok: false,
                msg: "addGradientFill only works on Shape layers. '" + (layer.name || args.layerName) +
                     "' is not a shape layer. To add a gradient to this layer, use: " +
                     "{ tool: 'applyEffect', args: { layerName: '" + (layer.name || args.layerName) +
                     "', effectMatchName: 'ADBE Ramp', properties: [{index:2,value:[R,G,B,A]},{index:4,value:[R,G,B,A]}] } }"
            };
        }
        try {
            var contents = layer.property("ADBE Root Vectors Group");
            var grp = null;
            if (args.groupName) {
                for (var gi = 1; gi <= contents.numProperties; gi++) {
                    if (contents.property(gi).name === args.groupName) { grp = contents.property(gi); break; }
                }
            }
            if (!grp && contents.numProperties > 0) grp = contents.property(1);
            if (!grp) {
                // Create a new group
                grp = contents.addProperty("ADBE Vector Group");
                grp.name = "Gradient Group";
            }
            var grpContents = grp.property("ADBE Vectors Group");
            var grad = grpContents.addProperty("ADBE Vector Graphic - G-Fill");
            var gradType = (args.type || "linear").toLowerCase() === "radial" ? 2 : 1;
            grad.property("ADBE Vector Grad Type").setValue(gradType);
            if (args.startPoint) grad.property("ADBE Vector Grad Start Pt").setValue(args.startPoint);
            if (args.endPoint) grad.property("ADBE Vector Grad End Pt").setValue(args.endPoint);
            // Build gradient stop color array: [pos1, r1, g1, b1, pos2, r2, g2, b2]
            var c1 = agentNormalizeColor(args.startColor || [1, 1, 1, 1]);
            var c2 = agentNormalizeColor(args.endColor || [0, 0, 0, 1]);
            var colorStops = grad.property("ADBE Vector Grad Colors");
            // Some AE versions reject object-style gradient stop payloads; keep a safe fallback.
            try {
                colorStops.setValue({ colorStops: [{ position: 0, color: c1 }, { position: 1, color: c2 }] });
                return { ok: true, msg: "Added gradient fill to '" + args.layerName + "'" };
            } catch (gsErr) {
                return { ok: true, msg: "Added gradient fill to '" + args.layerName + "' (default gradient colors kept by host)." };
            }
        } catch (e) {
            return { ok: false, msg: "addGradientFill failed: " + e.toString() };
        }
    }

    // --- TOOL: addStrokeToShape ---
    // args: { compName, layerName, groupName, color, width, lineCap, lineJoin, dashLength, dashGap }
    function agentTool_addStrokeToShape(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addStrokeToShape: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "addStrokeToShape: layer not found." };
        try {
            var contents = layer.property("ADBE Root Vectors Group");
            var grp = null;
            if (args.groupName) {
                for (var gi = 1; gi <= contents.numProperties; gi++) {
                    if (contents.property(gi).name === args.groupName) { grp = contents.property(gi); break; }
                }
            }
            if (!grp && contents.numProperties > 0) grp = contents.property(1);
            if (!grp) return { ok: false, msg: "addStrokeToShape: no group found." };
            var grpContents = grp.property("ADBE Vectors Group");
            var stroke = grpContents.addProperty("ADBE Vector Graphic - Stroke");
            var c = agentNormalizeColor(args.color || [1, 1, 1, 1]);
            stroke.property("ADBE Vector Stroke Color").setValue(c);
            var strokeW = (args.width !== undefined) ? args.width : 4;
            stroke.property("ADBE Vector Stroke Width").setValue(strokeW);
            if (args.lineCap) {
                var capMap = { "butt": 1, "round": 2, "projecting": 3 };
                try { stroke.property("ADBE Vector Stroke Line Cap").setValue(capMap[(args.lineCap || "round").toLowerCase()] || 2); } catch (ce) { }
            }
            if (args.dashLength) {
                try {
                    var dashes = stroke.property("ADBE Vector Stroke Dashes");
                    dashes.addProperty("ADBE Vector Stroke Dash 1").setValue(args.dashLength);
                    if (args.dashGap) dashes.addProperty("ADBE Vector Stroke Gap 1").setValue(args.dashGap);
                } catch (de) { }
            }
            return { ok: true, msg: "Added stroke (width=" + strokeW + ") to '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "addStrokeToShape failed: " + e.toString() };
        }
    }

    // --- TOOL: addShapeRepeater ---
    // args: { compName, layerName, groupName, copies, offset, positionOffset, rotationOffset, scaleStart, scaleEnd }
    function agentTool_addShapeRepeater(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addShapeRepeater: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "addShapeRepeater: layer not found." };
        try {
            var contents = layer.property("ADBE Root Vectors Group");
            var grp = null;
            if (args.groupName) {
                for (var gi = 1; gi <= contents.numProperties; gi++) {
                    if (contents.property(gi).name === args.groupName) { grp = contents.property(gi); break; }
                }
            }
            if (!grp && contents.numProperties > 0) grp = contents.property(1);
            if (!grp) return { ok: false, msg: "addShapeRepeater: no group found." };
            var grpContents = grp.property("ADBE Vectors Group");
            var repeater = grpContents.addProperty("ADBE Vector Filter - Repeater");
            var copiesVal = (args.copies !== undefined) ? args.copies : 3;
            var offsetVal = (args.offset !== undefined) ? args.offset : 0;
            repeater.property("ADBE Vector Repeater Copies").setValue(copiesVal);
            repeater.property("ADBE Vector Repeater Offset").setValue(offsetVal);
            var xform = repeater.property("ADBE Vector Repeater Transform");
            if (args.positionOffset) xform.property("ADBE Vector Repeater Position").setValue(args.positionOffset);
            if (args.rotationOffset !== undefined) xform.property("ADBE Vector Repeater Rotation").setValue(args.rotationOffset);
            if (args.scaleStart) xform.property("ADBE Vector Repeater Scale").setValue(args.scaleStart);
            return { ok: true, msg: "Added repeater (" + copiesVal + " copies) to '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "addShapeRepeater failed: " + e.toString() };
        }
    }

    // --- TOOL: addTrimPaths ---
    // args: { compName, layerName, groupName, start, end, offset }
    // start/end: 0-100 percent. Animates stroke draw-on effect.
    function agentTool_addTrimPaths(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addTrimPaths: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "addTrimPaths: layer not found." };
        try {
            var contents = layer.property("ADBE Root Vectors Group");
            var grp = null;
            if (args.groupName) {
                for (var gi = 1; gi <= contents.numProperties; gi++) {
                    if (contents.property(gi).name === args.groupName) { grp = contents.property(gi); break; }
                }
            }
            if (!grp && contents.numProperties > 0) grp = contents.property(1);
            if (!grp) return { ok: false, msg: "addTrimPaths: no group found." };
            var grpContents = grp.property("ADBE Vectors Group");
            var trim = grpContents.addProperty("ADBE Vector Filter - Trim");
            if (args.start !== undefined) trim.property("ADBE Vector Trim Start").setValue(args.start);
            if (args.end !== undefined) trim.property("ADBE Vector Trim End").setValue(args.end);
            if (args.offset !== undefined) trim.property("ADBE Vector Trim Offset").setValue(args.offset);
            var startMsg = (args.start !== undefined) ? args.start : 0;
            var endMsg = (args.end !== undefined) ? args.end : 100;
            return { ok: true, msg: "Added Trim Paths (start=" + startMsg + "%, end=" + endMsg + "%) to '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "addTrimPaths failed: " + e.toString() };
        }
    }

    // --- TOOL: addTrimPathsKeyframe ---
    // args: { compName, layerName, groupName, property ("start"|"end"|"offset"), time, value }
    function agentTool_addTrimPathsKeyframe(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "addTrimPathsKeyframe: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "addTrimPathsKeyframe: layer not found." };
        try {
            var contents = layer.property("ADBE Root Vectors Group");
            var grp = null;
            if (args.groupName) {
                for (var gi = 1; gi <= contents.numProperties; gi++) {
                    if (contents.property(gi).name === args.groupName) { grp = contents.property(gi); break; }
                }
            }
            if (!grp && contents.numProperties > 0) grp = contents.property(1);
            if (!grp) return { ok: false, msg: "addTrimPathsKeyframe: no group found." };
            var grpContents = grp.property("ADBE Vectors Group");
            var trim = null;
            for (var ti = 1; ti <= grpContents.numProperties; ti++) {
                if (grpContents.property(ti).matchName === "ADBE Vector Filter - Trim") {
                    trim = grpContents.property(ti); break;
                }
            }
            if (!trim) return { ok: false, msg: "addTrimPathsKeyframe: no Trim Paths found. Use addTrimPaths first." };
            var propNameMap = {
                "start": "ADBE Vector Trim Start",
                "end": "ADBE Vector Trim End",
                "offset": "ADBE Vector Trim Offset"
            };
            var pn = propNameMap[(args.property || "end").toLowerCase()] || "ADBE Vector Trim End";
            trim.property(pn).setValueAtTime(args.time || 0, args.value !== undefined ? args.value : 100);
            return { ok: true, msg: "Keyframed Trim Paths '" + args.property + "' to " + args.value + " at t=" + args.time };
        } catch (e) {
            return { ok: false, msg: "addTrimPathsKeyframe failed: " + e.toString() };
        }
    }

    // --- TOOL: setTimeRemapEnabled ---
    // args: { compName, layerName, enabled (bool) }
    function agentTool_setTimeRemapEnabled(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setTimeRemapEnabled: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "setTimeRemapEnabled: layer not found." };
        try {
            if (args.enabled !== false) {
                layer.timeRemapEnabled = true;
            } else {
                layer.timeRemapEnabled = false;
            }
            return { ok: true, msg: "Time Remap " + (args.enabled !== false ? "enabled" : "disabled") + " on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "setTimeRemapEnabled failed: " + e.toString() };
        }
    }

    // --- TOOL: setMotionBlur ---
    // args: { compName, layerName, motionBlur (bool), compMotionBlurEnabled (bool) }
    function agentTool_setMotionBlur(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setMotionBlur: comp not found." };
        var changed = [];
        try {
            if (args.compMotionBlurEnabled !== undefined) {
                comp.motionBlur = args.compMotionBlurEnabled;
                changed.push("comp motionBlur=" + comp.motionBlur);
            }
            if (args.layerName) {
                var layer = agentFindLayer(comp, args.layerName, context, args.compName);
                if (!layer) return { ok: false, msg: "setMotionBlur: layer not found." };
                layer.motionBlur = (args.motionBlur !== false);
                changed.push("layer motionBlur=" + layer.motionBlur);
            }
            return { ok: true, msg: "Set: " + changed.join(", ") };
        } catch (e) {
            return { ok: false, msg: "setMotionBlur failed: " + e.toString() };
        }
    }

    // --- TOOL: createFolderInProject ---
    // args: { folderName, parentFolderName }
    function agentTool_createFolderInProject(args, context) {
        var name = args.folderName || "New Folder";
        try {
            var folder = app.project.items.addFolder(name);
            if (args.parentFolderName) {
                var parentFolder = null;
                for (var fi = 1; fi <= app.project.numItems; fi++) {
                    var item = app.project.item(fi);
                    if (item instanceof FolderItem && item.name === args.parentFolderName) {
                        parentFolder = item;
                        break;
                    }
                }
                if (parentFolder) {
                    folder.parentFolder = parentFolder;
                    return { ok: true, msg: "Created project folder '" + name + "' inside '" + args.parentFolderName + "'" };
                }
                return { ok: true, msg: "Created project folder '" + name + "' (parent '" + args.parentFolderName + "' not found)." };
            }
            return { ok: true, msg: "Created project folder '" + name + "'" };
        } catch (e) {
            return { ok: false, msg: "createFolderInProject failed: " + e.toString() };
        }
    }

    // --- TOOL: setLayerStretch ---
    // args: { compName, layerName, stretch (percent, e.g. 200 = 2x slow, 50 = 2x fast) }
    function agentTool_setLayerStretch(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setLayerStretch: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "setLayerStretch: layer not found." };
        try {
            var stretchVal = (args.stretch !== undefined) ? parseFloat(args.stretch) : 100;
            if (isNaN(stretchVal)) stretchVal = 100;
            if (stretchVal === 0) return { ok: false, msg: "setLayerStretch: stretch cannot be 0." };
            if (stretchVal > 0 && stretchVal < 1) stretchVal = 1;
            if (stretchVal < 0 && stretchVal > -1) stretchVal = -1;
            if (stretchVal > 9900) stretchVal = 9900;
            if (stretchVal < -9900) stretchVal = -9900;
            layer.stretch = stretchVal;
            return { ok: true, msg: "Set stretch=" + stretchVal + "% on '" + args.layerName + "'" };
        } catch (e) {
            return { ok: false, msg: "setLayerStretch failed: " + e.toString() };
        }
    }

    // --- TOOL: applyExpressionToEffect ---
    // args: { compName, layerName|layerNames, useSelectedLayers, effectMatchName, propertyIndex, expression }
    function agentTool_applyExpressionToEffect(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "applyExpressionToEffect: comp not found." };
        if (!args.effectMatchName) return { ok: false, msg: "applyExpressionToEffect: effectMatchName is required." };
        if (!args.expression || args.expression === "") return { ok: false, msg: "applyExpressionToEffect: expression is required." };
        try {
            var targets = agentResolveTargetLayers(comp, args, context, args.compName);
            if (!targets.ok) return { ok: false, msg: "applyExpressionToEffect: " + targets.msg };

            var pIdx = parseInt(args.propertyIndex, 10);
            if (isNaN(pIdx) || pIdx < 1) pIdx = 1;

            var successNames = [];
            var failNotes = [];
            for (var li = 0; li < targets.layers.length; li++) {
                var layer = targets.layers[li];
                try {
                    var effect = agentFindEffectOnLayer(layer, args.effectMatchName);
                    if (!effect) {
                        failNotes.push(layer.name + " (effect not found)");
                        continue;
                    }
                    var prop = effect.property(pIdx);
                    if (!prop || !prop.canSetExpression) {
                        failNotes.push(layer.name + " (property " + pIdx + " not expressible)");
                        continue;
                    }
                    var applyRes = setExpressionOnPropertySafely(prop, layer, args.expression);
                    if (!applyRes.ok) {
                        failNotes.push(layer.name + " (" + applyRes.msg + ")");
                        continue;
                    }
                    successNames.push(layer.name);
                } catch (layerErr) {
                    failNotes.push(layer.name + " (" + layerErr.toString() + ")");
                }
            }

            if (successNames.length === 0) {
                return { ok: false, msg: "applyExpressionToEffect: no expressions were applied (" + agentShortList(failNotes, 3) + ")" };
            }
            var msg = "Applied expression to '" + args.effectMatchName + "' prop " + pIdx + " on " + successNames.length + " layer(s): " + agentShortList(successNames, 4);
            if (failNotes.length > 0) msg += ". Missed " + failNotes.length + ": " + agentShortList(failNotes, 2);
            if (targets.msg) msg += ". " + targets.msg;
            return { ok: true, msg: msg };
        } catch (e) {
            return { ok: false, msg: "applyExpressionToEffect failed: " + e.toString() };
        }
    }

    // --- TOOL: setCompRenderer ---
    // args: { compName, renderer ("advanced_3d"|"cinema4d"|"classic_3d") }
    function agentTool_setCompRenderer(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "setCompRenderer: comp not found." };
        try {
            var rMap = {
                "advanced_3d": "ADBE Advanced 3d",
                "cinema4d": "ADBE Ernst",
                "classic_3d": "ADBE Classic 3D"
            };
            var r = rMap[(args.renderer || "advanced_3d").toLowerCase()] || "ADBE Advanced 3d";
            comp.renderer = r;
            return { ok: true, msg: "Set renderer to '" + r + "' on '" + comp.name + "'" };
        } catch (e) {
            return { ok: false, msg: "setCompRenderer failed: " + e.toString() };
        }
    }

    // --- TOOL: scaleLayerRelative ---
    // args: { compName, layerName, scaleMultiplier (e.g. 2 = double), uniformScale (bool) }
    function agentTool_scaleLayerRelative(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "scaleLayerRelative: comp not found." };
        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "scaleLayerRelative: layer not found." };
        try {
            var current = layer.transform.scale.value;
            var mult = (args.scaleMultiplier !== undefined) ? args.scaleMultiplier : 1;
            var newScale = null;
            if (mult instanceof Array) {
                newScale = current.slice(0);
                for (var mi = 0; mi < newScale.length && mi < mult.length; mi++) {
                    newScale[mi] = current[mi] * mult[mi];
                }
            } else {
                newScale = current.slice(0);
                for (var si = 0; si < newScale.length; si++) {
                    newScale[si] = current[si] * mult;
                }
            }
            // Use setValueAtTime when keyframes exist to avoid AE "Can not call setValue() on a property with keyframes" error.
            var scaleProp = layer.transform.scale;
            if (scaleProp.numKeys && scaleProp.numKeys > 0) scaleProp.setValueAtTime(comp.workAreaStart || 0, newScale);
            else scaleProp.setValue(newScale);
            var msgVals = [];
            for (var sv = 0; sv < newScale.length; sv++) msgVals.push(newScale[sv].toFixed(1));
            return { ok: true, msg: "Scaled '" + args.layerName + "' by " + (mult instanceof Array ? "[" + mult.join(", ") + "]" : mult + "x") + " to [" + msgVals.join(", ") + "]" };
        } catch (e) {
            return { ok: false, msg: "scaleLayerRelative failed: " + e.toString() };
        }
    }

    // --- TOOL: getCompInfo ---
    // args: { compName }
    // Returns info about the comp for planning purposes (logs to the agent log)
    function agentTool_getCompInfo(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "getCompInfo: comp not found." };
        try {
            var layerList = [];
            for (var i = 1; i <= comp.numLayers; i++) {
                layerList.push("[" + i + "] " + comp.layer(i).name);
            }
            var info = "'" + comp.name + "' | " + comp.width + "x" + comp.height + " | " + comp.frameRate + "fps | " + comp.duration + "s | " + comp.numLayers + " layers: " + layerList.join(", ");
            return { ok: true, msg: info };
        } catch (e) {
            return { ok: false, msg: "getCompInfo failed: " + e.toString() };
        }
    }

    // --- TOOL: executeExtendScript (God Tool / Escape Hatch) ---
    // args: { script (string — raw ExtendScript code to execute) }
    // This is the hybrid fallback tool. Use ONLY when no dedicated tool can achieve the goal.
    function agentTool_executeExtendScript(args, context) {
        var script = args.script || "";
        if (!script || script === "") return { ok: false, msg: "executeExtendScript: no script provided." };

        // --- Safety blocklist ---
        var dangerousPatterns = [
            /\bsystem\.callSystem\b/i,
            /\bFile\s*\(/,
            /\bFolder\s*\(/,
            /\.open\s*\(/,
            /\.remove\s*\(/,
            /\.execute\s*\(/,
            /\bapp\.quit\b/i,
            /\bapp\.project\.close\b/i,
            /\bapp\.project\.save\b/i,
            /\b\$\.sleep\b/,
            /\bSocket\s*\(/,
            /\bExternalObject\b/
        ];
        for (var d = 0; d < dangerousPatterns.length; d++) {
            if (dangerousPatterns[d].test(script)) {
                return { ok: false, msg: "executeExtendScript BLOCKED: script contains forbidden operation (" + dangerousPatterns[d].toString() + "). Use dedicated tools or request user action instead." };
            }
        }

        // --- ES3 syntax validation (reuse existing validator) ---
        var violations = validateScript(script);
        if (violations.length > 0) {
            return { ok: false, msg: "executeExtendScript validation failed: " + violations.join("; ") };
        }

        // --- Execute in GLOBAL scope via temp file + $.evalFile ---
        // Use a unique filename per call to prevent collision on concurrent runs.
        // $.evalFile() accepts a File object directly — this is safer than passing
        // a string path, which breaks on Windows paths with spaces or Unicode.
        var tempScript = null;
        try {
            var _execTs = (new Date()).getTime();
            var _execRnd = Math.floor(Math.random() * 99999);
            tempScript = new File(Folder.temp.fsName + "/balongra_exec_" + _execTs + "_" + _execRnd + ".jsx");
            tempScript.encoding = "UTF-8";
            if (!tempScript.open("w")) {
                return { ok: false, msg: "executeExtendScript: could not open temp file for writing." };
            }
            tempScript.write(script);
            tempScript.close();

            var result = $.evalFile(tempScript);
            var resultStr = (result !== undefined && result !== null) ? String(result) : "(no return value)";
            if (resultStr.length > 500) resultStr = resultStr.substring(0, 500) + "...";
            return { ok: true, msg: "Executed in global scope. Result: " + resultStr };
        } catch (e) {
            var errMsg = e.toString();
            if (e.line) errMsg += " (line " + e.line + ")";
            return { ok: false, msg: "executeExtendScript error: " + errMsg };
        } finally {
            try {
                if (tempScript && tempScript.exists) tempScript.remove();
            } catch (cleanupErr) { }
        }
    }

    // Agent bridge tools
    function agentFindExpressionByName(name) {
        if (!name) return null;
        var target = String(name).toLowerCase();
        var i;
        for (i = 0; i < expressionLibrary.length; i++) {
            if (String(expressionLibrary[i].name || "").toLowerCase() === target) return expressionLibrary[i];
        }
        for (i = 0; i < expressionLibrary.length; i++) {
            if (String(expressionLibrary[i].name || "").toLowerCase().indexOf(target) !== -1) return expressionLibrary[i];
        }
        return null;
    }

    function agentFindScriptByName(name) {
        if (!name) return null;
        var target = String(name).toLowerCase();
        var i;
        for (i = 0; i < scriptLibrary.length; i++) {
            if (String(scriptLibrary[i].name || "").toLowerCase() === target) return scriptLibrary[i];
        }
        for (i = 0; i < scriptLibrary.length; i++) {
            if (String(scriptLibrary[i].name || "").toLowerCase().indexOf(target) !== -1) return scriptLibrary[i];
        }
        return null;
    }

    function agentGetConnection(context) {
        if (context && context.agentConnection && context.agentConnection.model && context.agentConnection.apiUrl) {
            return context.agentConnection;
        }
        return null;
    }

    function agentScriptRiskReason(scriptStr) {
        if (!scriptStr) return "";
        var checks = [
            { re: /\bsystem\.callSystem\b/i, reason: "system call" },
            { re: /\bFile\s*\(/, reason: "file I/O" },
            { re: /\bFolder\s*\(/, reason: "folder I/O" },
            { re: /\.open\s*\(/, reason: "file open" },
            { re: /\.remove\s*\(/, reason: "file remove" },
            { re: /\b\$\.sleep\b/, reason: "sleep/freeze ($.sleep can hang After Effects)" },
            { re: /\.execute\s*\(/, reason: "external execute" },
            { re: /\bapp\.quit\b/i, reason: "app quit" },
            { re: /\bapp\.project\.close\b/i, reason: "project close" },
            { re: /\bapp\.project\.save\b/i, reason: "project save" },
            { re: /\bSocket\s*\(/, reason: "socket/network" },
            { re: /\bExternalObject\b/, reason: "external object" }
        ];
        for (var i = 0; i < checks.length; i++) {
            if (checks[i].re.test(scriptStr)) return checks[i].reason;
        }
        return "";
    }

    function agentTool_applyLibraryExpression(args, context) {
        var expressionName = args.expressionName || args.name || args.libraryExpression;
        if (!expressionName) return { ok: false, msg: "applyLibraryExpression: expressionName is required." };
        var exprObj = agentFindExpressionByName(expressionName);
        if (!exprObj) return { ok: false, msg: "applyLibraryExpression: expression '" + expressionName + "' not found in library." };

        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "applyLibraryExpression: comp not found." };

        var targetProp = args.property || exprObj.targetProperty || "Any Property (Manual)";
        if (targetProp === "Any Property (Manual)" && !args.property) {
            return { ok: false, msg: "applyLibraryExpression: this library expression is manual-target. Provide args.property." };
        }

        var selectorArgs = {
            layerName: args.layerName,
            layerNames: args.layerNames,
            useSelectedLayers: args.useSelectedLayers
        };
        var targets = agentResolveTargetLayers(comp, selectorArgs, context, args.compName);
        if (!targets.ok) return { ok: false, msg: "applyLibraryExpression: " + targets.msg };

        var successNames = [];
        var failNotes = [];
        for (var li = 0; li < targets.layers.length; li++) {
            var layer = targets.layers[li];
            try {
                var prop = agentFindTransformProp(layer, targetProp);
                if (!prop) prop = layer.property(targetProp);
                if (!prop) prop = findProperty(layer, targetProp);
                if (!prop || !prop.canSetExpression) {
                    failNotes.push(layer.name + " (property '" + targetProp + "' unavailable)");
                    continue;
                }
                var applyRes = setExpressionOnPropertySafely(prop, layer, exprObj.expression || "");
                if (!applyRes.ok) {
                    failNotes.push(layer.name + " (" + applyRes.msg + ")");
                    continue;
                }
                successNames.push(layer.name);
            } catch (layerErr) {
                failNotes.push(layer.name + " (" + layerErr.toString() + ")");
            }
        }

        if (successNames.length === 0) {
            return { ok: false, msg: "applyLibraryExpression: no layers were updated (" + agentShortList(failNotes, 3) + ")" };
        }

        ensureExpressionMeta(exprObj);
        exprObj.usageCount = (exprObj.usageCount || 0) + successNames.length;
        exprObj.lastUsedAt = (new Date()).getTime();
        saveExpressions();

        var msg = "Applied library expression '" + exprObj.name + "' to " + successNames.length + " layer(s): " + agentShortList(successNames, 4);
        if (failNotes.length > 0) msg += ". Missed " + failNotes.length + ": " + agentShortList(failNotes, 2);
        return { ok: true, msg: msg };
    }

    function agentTool_runLibraryScript(args, context) {
        var scriptName = args.scriptName || args.name || args.libraryScript;
        if (!scriptName) return { ok: false, msg: "runLibraryScript: scriptName is required." };
        var scriptObj = agentFindScriptByName(scriptName);
        if (!scriptObj) return { ok: false, msg: "runLibraryScript: script '" + scriptName + "' not found in library." };
        if (!scriptObj.script || scriptObj.script === "") return { ok: false, msg: "runLibraryScript: script body is empty." };

        var violations = validateScript(scriptObj.script);
        if (violations.length > 0) return { ok: false, msg: "runLibraryScript: ES3 validation failed (" + violations.join(", ") + ")" };

        var risk = agentScriptRiskReason(scriptObj.script);
        if (risk !== "") return { ok: false, msg: "runLibraryScript blocked: script uses restricted operation (" + risk + ")." };

        var tempScript = null;
        try {
            var _libTs = (new Date()).getTime();
            tempScript = new File(Folder.temp.fsName + "/balongra_lib_" + _libTs + ".jsx");
            tempScript.encoding = "UTF-8";
            tempScript.open("w");
            tempScript.write(scriptObj.script);
            tempScript.close();
            var result = $.evalFile(tempScript);
            var resultStr = (result !== undefined && result !== null) ? String(result) : "(no return value)";
            if (resultStr.length > 360) resultStr = resultStr.substring(0, 360) + "...";
            return { ok: true, msg: "Ran library script '" + scriptObj.name + "'. Result: " + resultStr };
        } catch (e) {
            return { ok: false, msg: "runLibraryScript failed: " + e.toString() };
        } finally {
            try { if (tempScript && tempScript.exists) tempScript.remove(); } catch (x) { }
        }
    }

    function agentTool_generateExpressionFromPrompt(args, context) {
        try {
        var prompt = args.prompt || args.description || args.userRequest || "";
        if (!prompt) return { ok: false, msg: "generateExpressionFromPrompt: prompt is required." };
        var conn = agentGetConnection(context);
        if (!conn) return { ok: false, msg: "generateExpressionFromPrompt: API connection unavailable in this run." };

        var tier = (context && context.analysis && context.analysis.modelTier) ? context.analysis.modelTier : "medium";
        var sysPrompt = buildAISystemPrompt(prompt);
        var payloadStr = buildPayload(conn.model, sysPrompt, "Generate the After Effects expression JSON now.", 4096, tier);
        var req = callModelJSON(conn.model, conn.apiKey, conn.apiUrl, payloadStr, 90, null, "agent expression generator");
        if (!req.ok && tier !== "small") {
            var eLow = (req.error || "").toLowerCase();
            if (eLow.indexOf("model") !== -1 && (eLow.indexOf("not found") !== -1 || eLow.indexOf("unsupported") !== -1 || eLow.indexOf("invalid model") !== -1)) {
                payloadStr = buildPayload(conn.model, sysPrompt, "Generate the After Effects expression JSON now.", 4096, "small");
                req = callModelJSON(conn.model, conn.apiKey, conn.apiUrl, payloadStr, 90, null, "agent expression generator");
            }
        }
        if (!req.ok) return { ok: false, msg: req.error };

        var rawContent = extractModelText(conn.model, req.json);
        if (!rawContent || rawContent === "") return { ok: false, msg: "generateExpressionFromPrompt: model returned no text content." };
        var aiExp = extractJSON(rawContent);
        if (!aiExp || !aiExp.expression) return { ok: false, msg: "generateExpressionFromPrompt: could not parse expression JSON." };
        if (!validateExpression(aiExp.expression || "")) return { ok: false, msg: "generateExpressionFromPrompt: expression failed ES3 validation." };

        var desiredTarget = args.targetProperty || args.property || aiExp.targetProperty || "Any Property (Manual)";
        var targetValid = false;
        for (var tv = 0; tv < validTargetProperties.length; tv++) {
            if (validTargetProperties[tv] === desiredTarget) { targetValid = true; break; }
        }
        if (!targetValid) desiredTarget = "Any Property (Manual)";

        aiExp.name = args.expressionName || aiExp.name || ("AI " + prompt.substring(0, 28));
        aiExp.description = aiExp.description || ("Generated by Agent from: " + prompt.substring(0, 120));
        aiExp.targetProperty = desiredTarget;
        aiExp.group = "AI Generated";
        ensureExpressionMeta(aiExp);

        if (args.saveToLibrary !== false) {
            expressionLibrary.push(aiExp);
            saveExpressions();
        }

        if (args.applyNow === false) {
            return { ok: true, msg: "Generated expression '" + aiExp.name + "' (" + aiExp.targetProperty + "). Saved to library." };
        }

        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "generateExpressionFromPrompt: comp not found for apply step." };
        if (aiExp.targetProperty === "Any Property (Manual)" && !args.property) {
            return { ok: false, msg: "generateExpressionFromPrompt: generated target is manual; provide args.property or set applyNow=false." };
        }

        var selectorArgs = {
            layerName: args.layerName,
            layerNames: args.layerNames,
            useSelectedLayers: args.useSelectedLayers
        };
        var targets = agentResolveTargetLayers(comp, selectorArgs, context, args.compName);
        if (!targets.ok) return { ok: false, msg: "generateExpressionFromPrompt: " + targets.msg };

        var success = [];
        var fails = [];
        for (var li = 0; li < targets.layers.length; li++) {
            var layer = targets.layers[li];
            var propName = args.property || aiExp.targetProperty;
            var prop = agentFindTransformProp(layer, propName);
            if (!prop) prop = layer.property(propName);
            if (!prop) prop = findProperty(layer, propName);
            if (!prop || !prop.canSetExpression) {
                fails.push(layer.name + " (cannot target " + propName + ")");
                continue;
            }
            var res = setExpressionOnPropertySafely(prop, layer, aiExp.expression);
            if (!res.ok) fails.push(layer.name + " (" + res.msg + ")");
            else success.push(layer.name);
        }

        if (success.length === 0) return { ok: false, msg: "generateExpressionFromPrompt: generated expression could not be applied (" + agentShortList(fails, 3) + ")" };
        var msg = "Generated and applied '" + aiExp.name + "' to " + success.length + " layer(s): " + agentShortList(success, 4);
        if (fails.length > 0) msg += ". Missed " + fails.length + ": " + agentShortList(fails, 2);
        return { ok: true, msg: msg };
        } catch (e) { return { ok: false, msg: "generateExpressionFromPrompt error: " + e.toString() }; }
    }

    function agentTool_generateScriptFromPrompt(args, context) {
        var prompt = args.prompt || args.description || args.userRequest || "";
        if (!prompt) return { ok: false, msg: "generateScriptFromPrompt: prompt is required." };
        var conn = agentGetConnection(context);
        if (!conn) return { ok: false, msg: "generateScriptFromPrompt: API connection unavailable in this run." };

        var tier = (context && context.analysis && context.analysis.modelTier) ? context.analysis.modelTier : "medium";
        var sysPrompt = buildScriptAISystemPrompt(prompt);
        var payloadStr = buildPayload(conn.model, sysPrompt, "Generate the After Effects script JSON now.", 6144, tier);
        var req = callModelJSON(conn.model, conn.apiKey, conn.apiUrl, payloadStr, 100, null, "agent script generator");
        if (!req.ok && tier !== "small") {
            var sLow = (req.error || "").toLowerCase();
            if (sLow.indexOf("model") !== -1 && (sLow.indexOf("not found") !== -1 || sLow.indexOf("unsupported") !== -1 || sLow.indexOf("invalid model") !== -1)) {
                payloadStr = buildPayload(conn.model, sysPrompt, "Generate the After Effects script JSON now.", 6144, "small");
                req = callModelJSON(conn.model, conn.apiKey, conn.apiUrl, payloadStr, 100, null, "agent script generator");
            }
        }
        if (!req.ok) return { ok: false, msg: req.error };

        var rawContent = extractModelText(conn.model, req.json);
        if (!rawContent || rawContent === "") return { ok: false, msg: "generateScriptFromPrompt: model returned no text content." };
        var aiScript = extractJSON(rawContent);
        if (!aiScript || !aiScript.script) return { ok: false, msg: "generateScriptFromPrompt: could not parse script JSON." };
        if (!validateScriptBool(aiScript.script)) return { ok: false, msg: "generateScriptFromPrompt: script failed ES3 validation." };

        aiScript.name = args.scriptName || aiScript.name || ("AI Script " + prompt.substring(0, 24));
        aiScript.description = aiScript.description || ("Generated by Agent from: " + prompt.substring(0, 120));

        if (args.saveToLibrary !== false) {
            scriptLibrary.push(aiScript);
            saveScripts();
        }

        if (args.runNow !== true) {
            return { ok: true, msg: "Generated script '" + aiScript.name + "' and saved to library." };
        }

        var risk = agentScriptRiskReason(aiScript.script);
        if (risk !== "") return { ok: false, msg: "generateScriptFromPrompt blocked run: script uses restricted operation (" + risk + ")." };

        var tempScript = null;
        try {
            var _genTs = (new Date()).getTime();
            tempScript = new File(Folder.temp.fsName + "/balongra_gen_" + _genTs + ".jsx");
            tempScript.encoding = "UTF-8";
            tempScript.open("w");
            tempScript.write(aiScript.script);
            tempScript.close();
            var result = $.evalFile(tempScript);
            var resultStr = (result !== undefined && result !== null) ? String(result) : "(no return value)";
            if (resultStr.length > 360) resultStr = resultStr.substring(0, 360) + "...";
            return { ok: true, msg: "Generated and ran script '" + aiScript.name + "'. Result: " + resultStr };
        } catch (e) {
            return { ok: false, msg: "generateScriptFromPrompt run failed: " + e.toString() };
        } finally {
            try { if (tempScript && tempScript.exists) tempScript.remove(); } catch (x) { }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // PANEL GENERATOR TOOL
    // Generates a dockable ScriptUI panel from a natural-language prompt.
    // Opens immediately as a floating window AND saves a .jsx to disk.
    // ─────────────────────────────────────────────────────────────
    function agentTool_generatePanelFromPrompt(args, context) {
        try {
        var prompt = args.prompt || args.description || args.panelGoal || "";
        var panelName = args.panelName || args.name || "AI Panel";
        if (!prompt) return { ok: false, msg: "generatePanelFromPrompt: 'prompt' is required." };

        var conn = agentGetConnection(context);
        if (!conn) return { ok: false, msg: "generatePanelFromPrompt: API connection unavailable." };

        // Build a focused system prompt for panel generation
        var panelSysPrompt = [
            "You are an After Effects ScriptUI panel generator. Output ONLY a JSON object, no markdown.",
            "The user wants a minimal dockable panel. Generate the complete ExtendScript code for it.",
            "",
            "PANEL REQUIREMENTS:",
            "- Must work as both floating window AND dockable panel (use 'palette' for both)",
            "- Use ScriptUI: Group, Panel, Statictext, Edittext, Slider, Checkbox, Button",
            "- All controls must have sensible defaults",
            "- The main action button must execute the operation via app.project.activeItem",
            "- Use app.beginUndoGroup / app.endUndoGroup around any AE operations",
            "- Keep it minimal: only controls the user actually needs",
            "- Must be valid ExtendScript (ES3: no let/const/arrow functions/forEach/map)",
            "",
            "JSON FORMAT:",
            "{ \"panelName\": \"...\", \"description\": \"...\", \"script\": \"(full ExtendScript code)\" }",
            "",
            "THE SCRIPT must contain a self-executing function that:",
            "1. Detects if run as panel (thisObj) or standalone (Window)",
            "2. Creates the UI with all controls",
            "3. Wires button onClick to execute the AE operation",
            "",
            "EXAMPLE TEMPLATE (adapt for the user's request):",
            "(function(thisObj) {",
            "  var panel = (thisObj instanceof Panel) ? thisObj : new Window('palette', 'Panel Name', undefined, {resizeable: true});",
            "  panel.orientation = 'column';",
            "  panel.alignChildren = ['fill','top'];",
            "  panel.spacing = 8; panel.margins = 12;",
            "  // add controls here",
            "  var runBtn = panel.add('button', undefined, 'Apply');",
            "  runBtn.onClick = function() { /* AE operation */ };",
            "  if (panel instanceof Window) { panel.center(); panel.show(); }",
            "  else { panel.layout.layout(true); }",
            "})(this);"
        ].join("\n");

        var userMsg = "Create a ScriptUI panel for: " + prompt + "\n\nPanel name: " + panelName;
        var tier = (context && context.analysis && context.analysis.modelTier) ? context.analysis.modelTier : "medium";
        var payloadStr = buildPayload(conn.model, panelSysPrompt, userMsg, 8192, tier);
        var req = callModelJSON(conn.model, conn.apiKey, conn.apiUrl, payloadStr, 120, null, "panel generator");
        if (!req.ok) return { ok: false, msg: "generatePanelFromPrompt: API error — " + req.error };

        var rawContent = extractModelText(conn.model, req.json);
        if (!rawContent) return { ok: false, msg: "generatePanelFromPrompt: model returned no content." };

        var panelData = extractJSON(rawContent);
        if (!panelData || !panelData.script) return { ok: false, msg: "generatePanelFromPrompt: could not parse panel JSON." };

        // Security check: no destructive ops in panels
        var risk = agentScriptRiskReason(panelData.script);
        if (risk !== "") return { ok: false, msg: "generatePanelFromPrompt: panel script uses restricted operation (" + risk + ")." };
        // ES3 compliance check: ensure panel works in AE's ExtendScript engine
        var scriptViolations = validateScript(panelData.script);
        if (scriptViolations.length > 0) {
            return { ok: false, msg: "generatePanelFromPrompt: panel script uses ES6+ syntax not supported in AE (" + scriptViolations.join(", ") + "). Retry." };
        }

        var finalName = panelData.panelName || panelName;
        var safeFileName = finalName.replace(/[^a-zA-Z0-9_\-\s]/g, "").replace(/\s+/g, "_");

        // ── 1. Save .jsx to disk for dockable use ────────────────
        var scriptCode = panelData.script;
        var headerComment = "// " + finalName + "\n// Generated by Balongra AI — " + new Date().toString() + "\n// To dock: Window > " + safeFileName + ".jsx\n\n";
        scriptCode = headerComment + scriptCode;

        var saveResult = "";
        var savedPath = "";
        try {
            var aeScriptsUi = new Folder(Folder.appPackage.parent.fullName + "/Scripts/ScriptUI Panels");
            if (!aeScriptsUi.exists) aeScriptsUi.create();
            var outFile = new File(aeScriptsUi.fullName + "/" + safeFileName + ".jsx");
            outFile.encoding = "UTF-8";
            outFile.open("w");
            outFile.write(scriptCode);
            outFile.close();
            savedPath = outFile.fsName;
            saveResult = "Saved to ScriptUI Panels: " + safeFileName + ".jsx";
        } catch (saveErr) {
            // Fallback: save to Desktop
            try {
                var desktop = new Folder("~/Desktop");
                var outFile2 = new File(desktop.fullName + "/" + safeFileName + ".jsx");
                outFile2.encoding = "UTF-8";
                outFile2.open("w");
                outFile2.write(scriptCode);
                outFile2.close();
                savedPath = outFile2.fsName;
                saveResult = "Saved to Desktop: " + safeFileName + ".jsx";
            } catch (e2) {
                saveResult = "Could not save file: " + e2.toString();
            }
        }

        // ── 2. Launch panel immediately ───────────────────────────
        var openResult = "";
        try {
            var _panelTs = (new Date()).getTime();
            var tempPanel = new File(Folder.temp.fsName + "/balongra_panel_" + safeFileName + "_" + _panelTs + ".jsx");
            tempPanel.encoding = "UTF-8";
            tempPanel.open("w");
            tempPanel.write(panelData.script);
            tempPanel.close();
            $.evalFile(tempPanel);
            try { tempPanel.remove(); } catch (tr) {}
            openResult = "Panel opened immediately.";
        } catch (runErr) {
            openResult = "Could not auto-open panel (" + runErr.toString() + "). Load manually from " + (savedPath || "saved location") + ".";
        }

        // Save to script library for reuse
        if (args.saveToLibrary !== false) {
            scriptLibrary.push({
                name: finalName,
                script: panelData.script,
                description: panelData.description || ("Panel: " + prompt),
                isPanel: true
            });
            saveScripts();
        }

        return {
            ok: true,
            msg: "Panel '" + finalName + "' created. " + openResult + " " + saveResult
        };
        } catch (panelErr) { return { ok: false, msg: "generatePanelFromPrompt error: " + panelErr.toString() }; }
    }

    // ─────────────────────────────────────────────────────────────
    // SLIDER RIGGING ENGINE
    // Shared infrastructure for rigPropertyToController and
    // separateDimensions. Inspired by Essentially + Separate Any
    // Dimensions (Jake In Motion). ES3-safe throughout.
    // ─────────────────────────────────────────────────────────────

    // Detect which expression controller type best fits a given AE property.
    // Returns: "slider" | "angle" | "color" | "point" | "point3d" | "checkbox" | "unsupported"
    function agentGetControlTypeForProp(prop, layer) {
        if (!prop) return "slider";
        var valueType, matchName, propName;
        try { valueType  = prop.propertyValueType; } catch (e) { valueType  = null; }
        try { matchName  = prop.matchName || "";    } catch (e) { matchName  = ""; }
        try { propName   = prop.name     || "";     } catch (e) { propName   = ""; }

        // Dropdown / menu controls — can't be reliably linked
        if (matchName.indexOf("Dropdown") !== -1 || matchName.indexOf("-Menu") !== -1 ||
            propName === "Menu") {
            try {
                var par = prop.parentProperty;
                if (par && par.matchName === "ADBE Dropdown Control") return "unsupported";
            } catch (e2) {}
        }

        // Multi-dimensional types
        if (valueType === PropertyValueType.TwoD || valueType === PropertyValueType.TwoD_SPATIAL)
            return "point";
        if (valueType === PropertyValueType.ThreeD || valueType === PropertyValueType.ThreeD_SPATIAL) {
            // 2D layers report 3D for transform props — use point for them
            var is3DTransform = (matchName.indexOf("ADBE Position") !== -1 ||
                                 matchName.indexOf("ADBE Anchor Point") !== -1 ||
                                 matchName.indexOf("ADBE Scale") !== -1);
            if (is3DTransform && layer) {
                try { if (!layer.threeDLayer) return "point"; } catch (e3) {}
            }
            return "point3d";
        }
        if (valueType === PropertyValueType.COLOR) return "color";

        // 1D: angle vs checkbox vs slider
        if (valueType === PropertyValueType.OneD || valueType === PropertyValueType.CUSTOM_VALUE) {
            try {
                var units = prop.unitsText || "";
                if (units.indexOf("\u00b0") !== -1 || units.toLowerCase().indexOf("deg") !== -1)
                    return "angle";
            } catch (e4) {}
            var mnLow  = matchName.toLowerCase();
            var pnLow  = propName.toLowerCase();
            if (mnLow.indexOf("rotate") !== -1 || mnLow.indexOf("angle") !== -1 ||
                mnLow.indexOf("phase")  !== -1 || mnLow.indexOf("skew")  !== -1)
                return "angle";
            if (pnLow.indexOf("rotation") !== -1 || pnLow.indexOf("angle") !== -1 ||
                pnLow.indexOf("phase")    !== -1 || pnLow.indexOf("skew")  !== -1)
                return "angle";
            try {
                var val = prop.value;
                if ((val === 0 || val === 1) &&
                    (pnLow.indexOf("enable") !== -1 || pnLow.indexOf("on/off") !== -1 ||
                     pnLow.indexOf("visible") !== -1 || pnLow.indexOf("show") !== -1))
                    return "checkbox";
            } catch (e5) {}
            return "slider";
        }
        return "slider";
    }

    // matchName of the value property inside a given controller effect
    function agentGetControlValueMatchName(controlType) {
        if (controlType === "slider")   return "ADBE Slider Control-0001";
        if (controlType === "angle")    return "ADBE Angle Control-0001";
        if (controlType === "color")    return "ADBE Color Control-0001";
        if (controlType === "point")    return "ADBE Point Control-0001";
        if (controlType === "point3d")  return "ADBE Point3D Control-0001";
        if (controlType === "checkbox") return "ADBE Checkbox Control-0001";
        return "ADBE Slider Control-0001";
    }

    // matchName of the effect itself for addProperty()
    function agentGetControlEffectMatchName(controlType) {
        if (controlType === "slider")   return "ADBE Slider Control";
        if (controlType === "angle")    return "ADBE Angle Control";
        if (controlType === "color")    return "ADBE Color Control";
        if (controlType === "point")    return "ADBE Point Control";
        if (controlType === "point3d")  return "ADBE Point3D Control";
        if (controlType === "checkbox") return "ADBE Checkbox Control";
        return "ADBE Slider Control";
    }

    // Human-readable sub-property name used in expressions: effect("X")("Slider")
    function agentGetControlSubPropName(controlType) {
        if (controlType === "slider")   return "Slider";
        if (controlType === "angle")    return "Angle";
        if (controlType === "color")    return "Color";
        if (controlType === "point")    return "Point";
        if (controlType === "point3d")  return "3D Point";
        if (controlType === "checkbox") return "Checkbox";
        return "Slider";
    }

    // Build the link expression that reads from a named controller effect
    function agentBuildControlLinkExpr(controlName, controlType) {
        return 'effect("' + controlName + '")("' + agentGetControlSubPropName(controlType) + '")';
    }

    // Collect full keyframe data from a property (value + interp + ease).
    // Returns [] if no keyframes. ES3-safe — no Array methods.
    function agentCollectPropKeyframes(prop) {
        var out = [];
        if (!prop || !prop.numKeys || prop.numKeys === 0) return out;
        for (var k = 1; k <= prop.numKeys; k++) {
            var kd = { time: 0, value: null, inInterp: null, outInterp: null,
                       inEase: null, outEase: null };
            try { kd.time  = prop.keyTime(k);  } catch (e) {}
            try { kd.value = prop.keyValue(k); } catch (e) {}
            try {
                kd.inInterp  = prop.keyInInterpolationType(k);
                kd.outInterp = prop.keyOutInterpolationType(k);
            } catch (e) {}
            try {
                if (kd.inInterp === KeyframeInterpolationType.BEZIER ||
                    kd.outInterp === KeyframeInterpolationType.BEZIER) {
                    kd.inEase  = prop.keyInTemporalEase(k);
                    kd.outEase = prop.keyOutTemporalEase(k);
                }
            } catch (e) {}
            out.push(kd);
        }
        return out;
    }

    // Apply collected keyframes to a 1D or multi-D control property.
    // valueExtractFn(keyValue) → scalar or array to set on the control.
    function agentApplyKeyframesToControl(controlProp, keyframes, valueExtractFn) {
        if (!controlProp || !keyframes || keyframes.length === 0) return;
        for (var k = 0; k < keyframes.length; k++) {
            var kd = keyframes[k];
            try {
                var v = valueExtractFn ? valueExtractFn(kd.value) : kd.value;
                controlProp.setValueAtTime(kd.time, v);
                var ki = controlProp.nearestKeyIndex(kd.time);
                if (kd.inInterp !== null && kd.outInterp !== null) {
                    try { controlProp.setInterpolationTypeAtKey(ki, kd.inInterp, kd.outInterp); } catch (e) {}
                }
                if (kd.inEase && kd.outEase) {
                    try {
                        var ie = kd.inEase[0] || kd.inEase;
                        var oe = kd.outEase[0] || kd.outEase;
                        var infl_in  = Math.max(0.1, Math.min(100, ie.influence || 16.67));
                        var infl_out = Math.max(0.1, Math.min(100, oe.influence || 16.67));
                        controlProp.setTemporalEaseAtKey(ki,
                            [new KeyframeEase(ie.speed || 0, infl_in)],
                            [new KeyframeEase(oe.speed || 0, infl_out)]);
                    } catch (e2) {}
                }
            } catch (e3) {}
        }
    }

    // Build a unique effect name that doesn't collide with existing effect names.
    function agentGetUniqueControlName(baseName, effects) {
        if (!effects) return baseName;
        // Build a list of existing names
        var existing = [];
        try {
            for (var i = 1; i <= effects.numProperties; i++) {
                try { existing.push(effects.property(i).name); } catch (e) {}
            }
        } catch (e) {}
        // Check if baseName is free
        var taken = false;
        for (var j = 0; j < existing.length; j++) {
            if (existing[j] === baseName) { taken = true; break; }
        }
        if (!taken) return baseName;
        // Append counter suffix
        for (var n = 2; n < 200; n++) {
            var candidate = baseName + " (" + n + ")";
            var collision = false;
            for (var m = 0; m < existing.length; m++) {
                if (existing[m] === candidate) { collision = true; break; }
            }
            if (!collision) return candidate;
        }
        return baseName + " (x)";
    }

    // ─────────────────────────────────────────────────────────────
    // TOOL: rigPropertyToController
    // Creates an expression controller for each named property,
    // transfers the current value (and any keyframes) to the
    // controller, then links the property back via expression.
    //
    // args: {
    //   compName:   string
    //   layerName:  string | null  (falls back to selected)
    //   property:   string          — one property name/matchName
    //   properties: string[]        — OR multiple at once
    //   controllerLayerName: string — target layer for the controllers
    //                                 (defaults to same layer as property)
    // }
    // ─────────────────────────────────────────────────────────────
    function agentTool_rigPropertyToController(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "rigPropertyToController: comp not found." };

        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "rigPropertyToController: layer '" + args.layerName + "' not found." };

        // Normalize property list
        var propNames = [];
        if (args.properties instanceof Array) {
            for (var pi = 0; pi < args.properties.length; pi++) propNames.push(args.properties[pi]);
        } else if (args.property) {
            propNames.push(args.property);
        }
        if (propNames.length === 0)
            return { ok: false, msg: "rigPropertyToController: 'property' or 'properties' required." };

        // Controller target layer — default to same layer
        var ctrlLayer = layer;
        if (args.controllerLayerName && args.controllerLayerName !== args.layerName) {
            var cl = agentFindLayer(comp, args.controllerLayerName, context, args.compName);
            if (cl) ctrlLayer = cl;
        }

        // ── PHASE 1: collect ────────────────────────────────────
        // Read all data before touching anything to avoid stale refs.
        var items = [];
        var skipped = [];

        for (var pi2 = 0; pi2 < propNames.length; pi2++) {
            var pName = propNames[pi2];
            var prop = null;
            // Try transform prop first, then search recursively
            prop = agentFindTransformProp(layer, pName);
            if (!prop) {
                try { prop = layer.property(pName); } catch (e) {}
            }
            if (!prop) {
                prop = searchPropertyRecursive(layer, pName);
            }
            if (!prop) { skipped.push(pName + " (not found)"); continue; }
            if (!prop.canSetExpression) { skipped.push(pName + " (no expression support)"); continue; }

            var controlType = agentGetControlTypeForProp(prop, layer);
            if (controlType === "unsupported") { skipped.push(pName + " (unsupported type)"); continue; }

            var currentValue = null;
            try { currentValue = prop.value; } catch (e) { skipped.push(pName + " (no value)"); continue; }

            // Point control: strip Z from 3D values on 2D layers
            if (controlType === "point" && currentValue instanceof Array && currentValue.length > 2)
                currentValue = [currentValue[0], currentValue[1]];

            var keyframes = agentCollectPropKeyframes(prop);

            // Build a human-readable control name from the property name
            var ctrlName = agentGetUniqueControlName(pName, ctrlLayer.property("ADBE Effect Parade"));

            items.push({
                propName: pName,
                prop: prop,
                controlType: controlType,
                currentValue: currentValue,
                keyframes: keyframes,
                ctrlName: ctrlName
            });
        }

        if (items.length === 0)
            return { ok: false, msg: "rigPropertyToController: no valid properties found. Skipped: " + skipped.join("; ") };

        // ── PHASE 2: apply ──────────────────────────────────────
        try {
            var effects = ctrlLayer.property("ADBE Effect Parade");
            if (!effects) return { ok: false, msg: "rigPropertyToController: cannot access effects on controller layer." };

            var succeeded = [];
            var failed    = [];

            for (var ii = 0; ii < items.length; ii++) {
                var item = items[ii];
                try {
                    // 1. Create expression controller
                    var ctrl = effects.addProperty(agentGetControlEffectMatchName(item.controlType));
                    if (!ctrl) { failed.push(item.propName + " (addProperty failed)"); continue; }
                    ctrl.name = item.ctrlName;

                    // 2. Re-fetch by name (avoids stale ref after addProperty)
                    var freshCtrl = effects.property(item.ctrlName);
                    if (!freshCtrl) { failed.push(item.propName + " (re-fetch failed)"); continue; }
                    var ctrlValueProp = freshCtrl.property(agentGetControlValueMatchName(item.controlType));
                    if (!ctrlValueProp) { failed.push(item.propName + " (value prop not found)"); continue; }

                    // 3. Transfer value or keyframes
                    if (item.keyframes.length > 0) {
                        var extract = null; // identity: keyframe value → control value
                        if (item.controlType === "point") {
                            extract = function(v) {
                                return (v instanceof Array && v.length > 2) ? [v[0], v[1]] : v;
                            };
                        }
                        agentApplyKeyframesToControl(ctrlValueProp, item.keyframes, extract);
                    } else {
                        try { ctrlValueProp.setValue(item.currentValue); } catch (e) {}
                    }

                    // 4. Re-fetch property (adding effects can invalidate old ref)
                    var freshProp = agentFindTransformProp(layer, item.propName);
                    if (!freshProp) {
                        try { freshProp = layer.property(item.propName); } catch (e) {}
                    }
                    if (!freshProp) freshProp = searchPropertyRecursive(layer, item.propName);
                    if (!freshProp || !freshProp.canSetExpression) {
                        failed.push(item.propName + " (property lost after adding effect)");
                        continue;
                    }

                    // 5. Remove original keyframes, link via expression
                    try { while (freshProp.numKeys > 0) freshProp.removeKey(1); } catch (e) {}
                    freshProp.expression = agentBuildControlLinkExpr(item.ctrlName, item.controlType);

                    succeeded.push(item.propName);
                } catch (itemErr) {
                    failed.push(item.propName + " (" + itemErr.toString() + ")");
                }
            }

            var msg = "Rigged " + succeeded.length + " propert" + (succeeded.length === 1 ? "y" : "ies") +
                      " to expression controllers: " + succeeded.join(", ") + ".";
            if (failed.length  > 0) msg += " Failed: "  + failed.join("; ");
            if (skipped.length > 0) msg += " Skipped: " + skipped.join("; ");
            return { ok: succeeded.length > 0, msg: msg };

        } catch (e) {
            return { ok: false, msg: "rigPropertyToController error: " + e.toString() };
        }
    }

    // ─────────────────────────────────────────────────────────────
    // TOOL: separateDimensions
    // Decomposes an array property (Position, Scale, Color, etc.)
    // into N independent 1D slider controllers, one per dimension.
    // Transfers keyframes per-dimension with full ease data.
    // Mirrors the "Separate Any Dimensions" workflow (Jake In Motion).
    //
    // args: {
    //   compName:  string
    //   layerName: string
    //   property:  string   — property name or matchName
    //   dimNames:  string[] — optional custom dimension labels
    // }
    // ─────────────────────────────────────────────────────────────
    function agentTool_separateDimensions(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "separateDimensions: comp not found." };

        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "separateDimensions: layer '" + args.layerName + "' not found." };

        if (!args.property)
            return { ok: false, msg: "separateDimensions: 'property' is required." };

        // Camera/Light layers cannot host effect controllers
        if (layer instanceof CameraLayer || layer instanceof LightLayer)
            return { ok: false, msg: "separateDimensions: Camera/Light layers cannot host expression controllers." };

        // Locate property
        var prop = agentFindTransformProp(layer, args.property);
        if (!prop) try { prop = layer.property(args.property); } catch (e) {}
        if (!prop) prop = searchPropertyRecursive(layer, args.property);
        if (!prop)
            return { ok: false, msg: "separateDimensions: property '" + args.property + "' not found." };
        if (!prop.canSetExpression)
            return { ok: false, msg: "separateDimensions: property does not support expressions." };

        // ── PHASE 1: collect ────────────────────────────────────
        var currentValue;
        try { currentValue = prop.value; } catch (e) {
            return { ok: false, msg: "separateDimensions: cannot read property value." };
        }
        if (!(currentValue instanceof Array) || currentValue.length < 2)
            return { ok: false, msg: "separateDimensions: property must be an array with 2+ dimensions." };

        // Detect type and dimension metadata
        var matchName = "";
        try { matchName = prop.matchName || ""; } catch (e) {}
        var valueType = null;
        try { valueType = prop.propertyValueType; } catch (e) {}

        var isColor   = (valueType === PropertyValueType.COLOR);
        var isSpatial = false;
        try { isSpatial = !!prop.isSpatial; } catch (e) {}

        var isAngle = (matchName.indexOf("Orientation") !== -1 ||
                       matchName === "ADBE Orientation" ||
                       matchName === "ADBE Vector Orientation");

        var ctrlType = isAngle ? "angle" : "slider";

        // For 2D layers, transform array props report 3D — clamp to 2
        var isLayerTransform = (matchName === "ADBE Scale" ||
                                matchName === "ADBE Position" ||
                                matchName === "ADBE Anchor Point");
        var dimCount = currentValue.length;
        if (isLayerTransform && !layer.threeDLayer) dimCount = Math.min(dimCount, 2);
        if (isColor) dimCount = Math.min(dimCount, 3); // skip alpha channel

        // Default dimension names
        var defaultDimNames;
        if (isColor) {
            defaultDimNames = ["R", "G", "B"];
        } else if (isAngle) {
            defaultDimNames = ["X Rotation", "Y Rotation", "Z Rotation"];
        } else {
            defaultDimNames = ["X", "Y", "Z", "W"];
        }
        var dimNames = (args.dimNames instanceof Array && args.dimNames.length >= dimCount)
            ? args.dimNames : defaultDimNames;

        // Extract current values per dimension (color: 0-1 → 0-100 for readability)
        var dimValues = [];
        for (var d = 0; d < dimCount; d++) {
            var v = currentValue[d];
            if (isColor) v = v * 100;
            dimValues.push(v);
        }

        // Collect all keyframes from the source property
        var allKeyframes = agentCollectPropKeyframes(prop);

        // Build unique control names, checking existing effects
        var effects = layer.property("ADBE Effect Parade");
        var effectMatchName = agentGetControlEffectMatchName(ctrlType);
        var valuePropMatchName = agentGetControlValueMatchName(ctrlType);
        var subPropName = agentGetControlSubPropName(ctrlType);
        var propBaseName = prop.name || args.property;
        var ctrlNames = [];
        // Build the name list incrementally so duplicates within the set are also avoided
        var reservedNames = [];
        try {
            for (var ei = 1; ei <= effects.numProperties; ei++) {
                try { reservedNames.push(effects.property(ei).name); } catch (e) {}
            }
        } catch (e) {}
        for (var d2 = 0; d2 < dimCount; d2++) {
            var baseName = propBaseName + " - " + dimNames[d2];
            // Check collisions against reserved + already-chosen names
            var taken = false;
            for (var rn = 0; rn < reservedNames.length; rn++) {
                if (reservedNames[rn] === baseName) { taken = true; break; }
            }
            if (!taken) {
                ctrlNames.push(baseName);
                reservedNames.push(baseName);
                continue;
            }
            for (var suf = 2; suf < 200; suf++) {
                var cand = baseName + " (" + suf + ")";
                var collision = false;
                for (var rn2 = 0; rn2 < reservedNames.length; rn2++) {
                    if (reservedNames[rn2] === cand) { collision = true; break; }
                }
                if (!collision) { ctrlNames.push(cand); reservedNames.push(cand); break; }
            }
        }

        // ── PHASE 2: apply ──────────────────────────────────────
        try {
            // Create one controller per dimension
            for (var d3 = 0; d3 < dimCount; d3++) {
                var newCtrl = effects.addProperty(effectMatchName);
                if (!newCtrl)
                    return { ok: false, msg: "separateDimensions: addProperty failed on dim " + d3 };
                newCtrl.name = ctrlNames[d3];
            }

            // Re-fetch fresh references after all addProperty calls
            var ctrlProps = [];
            for (var d4 = 0; d4 < dimCount; d4++) {
                var freshEffect = effects.property(ctrlNames[d4]);
                if (!freshEffect)
                    return { ok: false, msg: "separateDimensions: re-fetch failed for '" + ctrlNames[d4] + "'" };
                var freshValProp = freshEffect.property(valuePropMatchName);
                if (!freshValProp)
                    return { ok: false, msg: "separateDimensions: value property not found in '" + ctrlNames[d4] + "'" };
                ctrlProps.push(freshValProp);
            }

            // Transfer values / keyframes per dimension
            if (allKeyframes.length > 0) {
                for (var k = 0; k < allKeyframes.length; k++) {
                    var kf = allKeyframes[k];
                    var kfVal = kf.value;
                    for (var d5 = 0; d5 < dimCount; d5++) {
                        try {
                            var scalar = (kfVal instanceof Array) ? kfVal[d5] : kfVal;
                            if (isColor) scalar = scalar * 100;
                            ctrlProps[d5].setValueAtTime(kf.time, scalar);
                            var ki = ctrlProps[d5].nearestKeyIndex(kf.time);
                            if (kf.inInterp !== null && kf.outInterp !== null) {
                                try { ctrlProps[d5].setInterpolationTypeAtKey(ki, kf.inInterp, kf.outInterp); } catch (e) {}
                            }
                            if (kf.inEase && kf.outEase) {
                                // Spatial props share one ease across dims; non-spatial have per-dim ease
                                var eIdx = isSpatial ? 0 : Math.min(d5, kf.inEase.length - 1);
                                var ie   = kf.inEase[eIdx]  || kf.inEase[0];
                                var oe   = kf.outEase[eIdx] || kf.outEase[0];
                                var infl_in  = Math.max(0.1, Math.min(100, ie.influence  || 16.67));
                                var infl_out = Math.max(0.1, Math.min(100, oe.influence  || 16.67));
                                try {
                                    ctrlProps[d5].setTemporalEaseAtKey(ki,
                                        [new KeyframeEase(ie.speed  || 0, infl_in)],
                                        [new KeyframeEase(oe.speed  || 0, infl_out)]);
                                } catch (e2) {}
                            }
                        } catch (kErr) {}
                    }
                }
            } else {
                // No keyframes — just set static values
                for (var d6 = 0; d6 < dimCount; d6++) {
                    try { ctrlProps[d6].setValue(dimValues[d6]); } catch (e) {}
                }
            }

            // Re-fetch source property (stale after addProperty calls)
            var freshProp = agentFindTransformProp(layer, args.property);
            if (!freshProp) try { freshProp = layer.property(args.property); } catch (e) {}
            if (!freshProp) freshProp = searchPropertyRecursive(layer, args.property);
            if (!freshProp || !freshProp.canSetExpression)
                return { ok: false, msg: "separateDimensions: source property reference lost after adding effects." };

            // Remove original keyframes
            try { while (freshProp.numKeys > 0) freshProp.removeKey(1); } catch (e) {}

            // Build assembly expression: [dim0, dim1] or [dim0/100, dim1/100, dim2/100, 1]
            var exprLines = [];
            var varNames  = [];
            for (var d7 = 0; d7 < dimCount; d7++) {
                var vn = "d" + d7;
                varNames.push(vn);
                exprLines.push('var ' + vn + ' = effect("' + ctrlNames[d7] + '")("' + subPropName + '");');
            }
            if (isColor) {
                // Reconstruct RGBA: convert 0-100 back to 0-1, restore alpha=1
                var colorTerms = [];
                for (var d8 = 0; d8 < dimCount; d8++) colorTerms.push(varNames[d8] + " / 100");
                exprLines.push("[" + colorTerms.join(", ") + ", 1];");
            } else {
                exprLines.push("[" + varNames.join(", ") + "];");
            }
            try {
                freshProp.expression = exprLines.join("\n");
            } catch (expErr) {
                return { ok: false, msg: "separateDimensions: expression apply failed: " + expErr.toString() };
            }

            var kfNote = (allKeyframes.length > 0)
                ? " Transferred " + allKeyframes.length + " keyframe(s) per dimension."
                : "";
            return {
                ok: true,
                msg: "Separated '" + args.property + "' into " + dimCount + " independent controllers: " +
                     ctrlNames.join(", ") + "." + kfNote
            };

        } catch (e) {
            return { ok: false, msg: "separateDimensions error: " + e.toString() };
        }
    }

    // ─────────────────────────────────────────────────────────────
    // TOOL: exposeToEssentialGraphics
    // Exposes a property to the Essential Graphics Panel (MOGRT).
    // Requires the JavaScript expressions engine.
    // Inspired by Essentially.jsx (Jake In Motion) — addToMotionGraphicsTemplateAs().
    //
    // args: {
    //   compName:     string   — target comp (becomes the MOGRT root)
    //   layerName:    string   — layer that owns the property
    //   property:     string   — property name or matchName
    //   displayName:  string?  — label shown in Essential Graphics panel
    // }
    // ─────────────────────────────────────────────────────────────
    function agentTool_exposeToEssentialGraphics(args, context) {
        var comp = agentFindComp(args.compName, context);
        if (!comp) return { ok: false, msg: "exposeToEssentialGraphics: comp not found." };

        var layer = agentFindLayer(comp, args.layerName, context, args.compName);
        if (!layer) return { ok: false, msg: "exposeToEssentialGraphics: layer '" + args.layerName + "' not found." };
        if (!args.property) return { ok: false, msg: "exposeToEssentialGraphics: 'property' is required." };

        try {
            var prop = agentFindTransformProp(layer, args.property);
            if (!prop) { try { prop = layer.property(args.property); } catch (e) {} }
            if (!prop) prop = searchPropertyRecursive(layer, args.property);
            if (!prop) return { ok: false, msg: "exposeToEssentialGraphics: property '" + args.property + "' not found on layer '" + args.layerName + "'." };

            var displayName = args.displayName || prop.name;

            // addToMotionGraphicsTemplateAs(comp, name) — single AE call
            // comp = the root comp that will become the MOGRT
            prop.addToMotionGraphicsTemplateAs(comp, displayName);

            return { ok: true, msg: "Exposed '" + prop.name + "' to Essential Graphics panel as '" + displayName + "' in comp '" + comp.name + "'." };
        } catch (e) {
            return { ok: false, msg: "exposeToEssentialGraphics failed: " + e.toString() };
        }
    }

    var AGENT_TOOL_REGISTRY = {
        createComposition: true,
        createSolidLayer: true,
        createTextLayer: true,
        createShapeLayer: true,
        createNullLayer: true,
        createCameraLayer: true,
        createLightLayer: true,
        setLayerProperties: true,
        addKeyframe: true,
        applyEffect: true,
        applyExpression: true,
        setLayerParent: true,
        duplicateLayer: true,
        deleteLayer: true,
        renameLayer: true,
        generatePanelFromPrompt: true,
        precomposeLayer: true,
        addMarker: true,
        setCompSettings: true,
        setKeyframeInterpolation: true,
        removeEffect: true,
        setEffectProperty: true,
        addEffectKeyframe: true,
        removeExpression: true,
        setLayerLabel: true,
        setLayerSolo: true,
        setLayerEnabled: true,
        setLayerLocked: true,
        reorderLayer: true,
        trimLayer: true,
        splitLayer: true,
        setCurrentTime: true,
        addAdjustmentLayer: true,
        addTextAnimator: true,
        updateTextContent: true,
        setAnchorAndPosition: true,
        alignLayersInComp: true,
        distributeLayersEvenly: true,
        groupLayersUnderNull: true,
        addShapePathKeyframe: true,
        addGradientFill: true,
        addStrokeToShape: true,
        addShapeRepeater: true,
        addTrimPaths: true,
        addTrimPathsKeyframe: true,
        setTimeRemapEnabled: true,
        setMotionBlur: true,
        createFolderInProject: true,
        setLayerStretch: true,
        applyExpressionToEffect: true,
        setCompRenderer: true,
        scaleLayerRelative: true,
        getCompInfo: true,
        applyLibraryExpression: true,
        runLibraryScript: true,
        generateExpressionFromPrompt: true,
        generateScriptFromPrompt: true,
        executeExtendScript: true,
        // Compatibility aliases accepted as first-class names.
        generateExpression: true,
        generateScript: true,
        applySavedExpression: true,
        runSavedScript: true,
        // Slider rigging tools
        rigPropertyToController: true,
        separateDimensions: true,
        // Essential Graphics Panel
        exposeToEssentialGraphics: true
    };

    var AGENT_TOOL_NAME_ALIASES = {
        setkeyframeease: "setKeyframeInterpolation",
        setkeyframeeasing: "setKeyframeInterpolation",
        seteasing: "setKeyframeInterpolation",
        setease: "setKeyframeInterpolation",
        setkeyease: "setKeyframeInterpolation",
        keyframeinterpolation: "setKeyframeInterpolation",
        addtext: "createTextLayer",
        createtext: "createTextLayer",
        addtextlayer: "createTextLayer",
        setexpression: "applyExpression",
        applyexpr: "applyExpression",
        applyexpressioneffect: "applyExpressionToEffect",
        runscript: "runLibraryScript",
        runscriptfromlibrary: "runLibraryScript",
        applylibraryexpr: "applyLibraryExpression",
        applysavedexpr: "applyLibraryExpression",
        compinfo: "getCompInfo",
        getcompositioninfo: "getCompInfo",
        extendscript: "executeExtendScript",
        executablescript: "executeExtendScript",
        generateexpr: "generateExpressionFromPrompt",
        createscriptfromprompt: "generateScriptFromPrompt",
        createexpressionfromprompt: "generateExpressionFromPrompt",
        generatepanel: "generatePanelFromPrompt",
        createpanel: "generatePanelFromPrompt",
        makepanel: "generatePanelFromPrompt",
        buildpanel: "generatePanelFromPrompt",
        createplugin: "generatePanelFromPrompt",
        makeplugin: "generatePanelFromPrompt",
        // Slider rigging aliases
        rigproperty: "rigPropertyToController",
        rigtoslider: "rigPropertyToController",
        rigpropertytocontroller: "rigPropertyToController",
        linkpropertytocontroller: "rigPropertyToController",
        exposecontroller: "rigPropertyToController",
        separatedimensions: "separateDimensions",
        splitdimensions: "separateDimensions",
        separateaxes: "separateDimensions",
        splitaxes: "separateDimensions",
        separateposition: "separateDimensions",
        separatescale: "separateDimensions",
        // Essential Graphics aliases
        exposetoessentialgraphics: "exposeToEssentialGraphics",
        addtoessentialgraphics: "exposeToEssentialGraphics",
        exposetomogrt: "exposeToEssentialGraphics",
        addtomogrt: "exposeToEssentialGraphics",
        essentialgraphics: "exposeToEssentialGraphics",
        exposepropertytoegp: "exposeToEssentialGraphics"
    };

    function agentNormalizeToolKey(name) {
        return String(name || "").toLowerCase().replace(/[\s_\-]+/g, "");
    }

    function canonicalizeAgentToolName(name) {
        var raw = String(name || "").replace(/^\s+|\s+$/g, "");
        if (raw === "") return "";
        if (AGENT_TOOL_REGISTRY[raw]) return raw;

        var compact = agentNormalizeToolKey(raw);
        if (AGENT_TOOL_NAME_ALIASES[compact]) return AGENT_TOOL_NAME_ALIASES[compact];

        // Case-insensitive fallback against known tool names.
        for (var known in AGENT_TOOL_REGISTRY) {
            if (!AGENT_TOOL_REGISTRY.hasOwnProperty(known)) continue;
            if (agentNormalizeToolKey(known) === compact) return known;
        }
        return raw;
    }

    function isKnownAgentToolName(name) {
        return AGENT_TOOL_REGISTRY[name] === true;
    }

    function getAgentPlanMaxToolCalls(analysisResult) {
        if (analysisResult && analysisResult.isFathersMoneyMode) return 260;
        if (analysisResult && analysisResult.isGoldMode) return 170;
        if (analysisResult && analysisResult.isHardMode) return 120;
        return 70;
    }

    function buildSkillPlanKey(compName, layerName, propertyName) {
        return String(compName || "") + "|" + String(layerName || "") + "|" + String(propertyName || "");
    }

    function hasSkill(analysisResult, skillKey) {
        if (!analysisResult || !analysisResult.skills) return false;
        for (var i = 0; i < analysisResult.skills.length; i++) {
            if (analysisResult.skills[i] === skillKey) return true;
        }
        return false;
    }

    function isBridgeToolName(toolName) {
        return (toolName === "applyLibraryExpression" ||
            toolName === "runLibraryScript" ||
            toolName === "generateExpressionFromPrompt" ||
            toolName === "generateScriptFromPrompt" ||
            toolName === "generateExpression" ||
            toolName === "generateScript" ||
            toolName === "applySavedExpression" ||
            toolName === "runSavedScript");
    }

    function agentCloneCallArgs(obj) {
        if (!obj || typeof obj !== "object") return {};
        var out = {};
        for (var k in obj) {
            if (!obj.hasOwnProperty(k)) continue;
            var v = obj[k];
            if (v && typeof v === "object") {
                if (v instanceof Array) {
                    var arr = [];
                    for (var i = 0; i < v.length; i++) arr.push(v[i]);
                    out[k] = arr;
                } else {
                    var nested = {};
                    for (var nk in v) if (v.hasOwnProperty(nk)) nested[nk] = v[nk];
                    out[k] = nested;
                }
            } else {
                out[k] = v;
            }
        }
        return out;
    }

    function agentHasLayerSelector(args) {
        if (!args) return false;
        if (args.layerName !== undefined && args.layerName !== null && String(args.layerName).replace(/^\s+|\s+$/g, "") !== "") return true;
        if (args.layerNames instanceof Array && args.layerNames.length > 0) return true;
        if (args.useSelectedLayers === true || args.applyToSelected === true || args.selected === true) return true;
        return false;
    }

    function agentToolNeedsLayerSelector(toolName) {
        var scoped = {
            setLayerProperties: true,
            addKeyframe: true,
            applyEffect: true,
            applyExpression: true,
            setKeyframeInterpolation: true,
            removeEffect: true,
            setEffectProperty: true,
            addEffectKeyframe: true,
            removeExpression: true,
            setLayerLabel: true,
            setLayerSolo: true,
            setLayerEnabled: true,
            setLayerLocked: true,
            reorderLayer: true,
            trimLayer: true,
            splitLayer: true,
            setLayerStretch: true,
            applyExpressionToEffect: true,
            scaleLayerRelative: true,
            addTextAnimator: true,
            updateTextContent: true,
            setAnchorAndPosition: true,
            addShapePathKeyframe: true,
            addGradientFill: true,
            addStrokeToShape: true,
            addShapeRepeater: true,
            addTrimPaths: true,
            addTrimPathsKeyframe: true,
            setTimeRemapEnabled: true,
            setMotionBlur: true,
            applyLibraryExpression: true
        };
        return scoped[toolName] === true;
    }

    function agentToolNeedsPropertyArg(toolName) {
        var propTools = {
            setLayerProperties: true,
            addKeyframe: true,
            applyExpression: true,
            setKeyframeInterpolation: true,
            removeExpression: true,
            scaleLayerRelative: true
        };
        return propTools[toolName] === true;
    }

    function agentDefaultValueForProperty(propName, compRef) {
        var prop = String(propName || "position").toLowerCase().replace(/\s+/g, "");
        var w = 1920, h = 1080;
        if (compRef && compRef.width && compRef.height) {
            w = compRef.width;
            h = compRef.height;
        }
        if (prop === "position" || prop === "anchorpoint") return [Math.round(w / 2), Math.round(h / 2)];
        if (prop === "scale") return [100, 100];
        if (prop === "opacity") return 100;
        if (prop === "rotation" || prop === "rotationz" || prop === "xrotation" || prop === "yrotation") return 0;
        if (prop === "sourcetext") return "Text";
        if (prop === "timeremap" || prop === "time remap") return 0;
        return 0;
    }

    function agentCoercePlanValueForProperty(propName, rawValue, compRef) {
        var prop = String(propName || "position").toLowerCase().replace(/\s+/g, "");
        var val = rawValue;
        if (val === undefined) val = agentDefaultValueForProperty(prop, compRef);
        if (prop === "position" || prop === "anchorpoint" || prop === "scale") {
            if (val instanceof Array) {
                if (val.length >= 2) return [val[0], val[1]];
                if (val.length === 1) return [val[0], val[0]];
            }
            var scalar = parseFloat(val);
            if (isNaN(scalar)) {
                var def = agentDefaultValueForProperty(prop, compRef);
                return (def instanceof Array) ? def : [0, 0];
            }
            return [scalar, scalar];
        }
        if (prop === "opacity" || prop === "rotation" || prop === "xrotation" || prop === "yrotation" || prop === "timeremap") {
            var n = parseFloat(val);
            if (isNaN(n)) return parseFloat(agentDefaultValueForProperty(prop, compRef)) || 0;
            return n;
        }
        return val;
    }

    function agentPreflightRepairCall(toolName, args, analysisResult, warnings, callIndex) {
        var outTool = toolName;
        var outArgs = agentCloneCallArgs(args);
        var notes = [];
        var fatal = "";
        var idx = (callIndex !== undefined) ? (callIndex + 1) : 0;
        var compRef = null;
        try { compRef = agentFindComp(outArgs.compName, null); } catch (e) { compRef = null; }

        function note(msg) {
            if (warnings) warnings.push("Preflight repaired call #" + idx + " (" + outTool + "): " + msg);
            notes.push(msg);
        }

        function hasString(x) {
            return (x !== undefined && x !== null && String(x).replace(/^\s+|\s+$/g, "") !== "");
        }

        if (agentToolNeedsLayerSelector(outTool) && !agentHasLayerSelector(outArgs)) {
            outArgs.useSelectedLayers = true;
            note("missing layer target -> using selected layer(s)");
        }

        if (agentToolNeedsPropertyArg(outTool) && !hasString(outArgs.property)) {
            outArgs.property = "position";
            note("missing property -> defaulted to 'position'");
        }

        if (outTool === "createTextLayer" && !hasString(outArgs.text)) {
            outArgs.text = hasString(outArgs.name) ? outArgs.name : "Text";
            note("missing text -> using fallback text");
        }

        if (outTool === "setLayerLabel" && !hasString(outArgs.label) && outArgs.label !== 0) {
            outArgs.label = "cyan";
            note("missing label -> using 'cyan'");
        }

        if (outTool === "setKeyframeInterpolation") {
            if (!hasString(outArgs.property)) {
                outArgs.property = "position";
                note("missing property -> defaulted to 'position'");
            }
            if (outArgs.allKeys !== true && (outArgs.keyIndex === undefined || outArgs.keyIndex === null)) {
                outArgs.allKeys = true;
                note("missing key target -> applying to all keys");
            }
        }

        if (outTool === "addKeyframe") {
            if (outArgs.time === undefined || outArgs.time === null || isNaN(parseFloat(outArgs.time))) {
                outArgs.time = 0;
                note("missing/invalid time -> defaulted to 0");
            }
            if (!hasString(outArgs.property)) {
                outArgs.property = "position";
                note("missing property -> defaulted to 'position'");
            }
            outArgs.value = agentCoercePlanValueForProperty(outArgs.property, outArgs.value, compRef);
            if (outArgs.value === undefined) {
                fatal = "missing value";
            }
        }

        if (outTool === "setLayerProperties") {
            var hasPayload = false;
            var payloadKeys = ["position", "scale", "rotation", "opacity", "anchorPoint", "inPoint", "outPoint", "is3DLayer", "motionBlur", "blendMode"];
            for (var pk = 0; pk < payloadKeys.length; pk++) {
                var key = payloadKeys[pk];
                if (outArgs[key] !== undefined) { hasPayload = true; break; }
            }
            if (!hasPayload) {
                // Mark as a silent no-op skip rather than a fatal failure.
                // Counting this as a failure inflates failCount and can trigger the
                // circuit breaker on valid plans where the model emits an empty
                // setLayerProperties as a placeholder. Return early with a special
                // "skip" fatal tag so the runner can log it without counting it.
                return { ok: false, fatal: "skip", tool: outTool, args: outArgs,
                    notes: ["empty setLayerProperties silently skipped (no properties to set)"] };
            }
        }

        if (outTool === "applyExpression" && !hasString(outArgs.expression)) {
            if (analysisResult && hasString(analysisResult.originalRequest)) {
                outTool = "generateExpressionFromPrompt";
                outArgs.prompt = analysisResult.originalRequest;
                outArgs.applyNow = true;
                outArgs.saveToLibrary = true;
                if (!hasString(outArgs.property)) outArgs.property = "position";
                note("missing expression -> upgraded to generateExpressionFromPrompt");
            } else {
                fatal = "missing expression";
            }
        }

        if ((outTool === "generateExpressionFromPrompt" || outTool === "generateScriptFromPrompt") &&
            !hasString(outArgs.prompt) && analysisResult && hasString(analysisResult.originalRequest)) {
            outArgs.prompt = analysisResult.originalRequest;
            note("missing prompt -> copied from original request");
        }

        if (outTool === "generateScriptFromPrompt") {
            // Block boilerplate calls where the model is using this as a filler step.
            // It should only run when the user explicitly asked for a reusable script.
            // Heuristic: if the prompt is just the full original request with no
            // specific script goal, it's a filler call — drop it.
            if (hasString(outArgs.prompt) && analysisResult && hasString(analysisResult.originalRequest)) {
                var promptNorm = String(outArgs.prompt).replace(/^\s+|\s+$/g, "").toLowerCase();
                var reqNorm = String(analysisResult.originalRequest).replace(/^\s+|\s+$/g, "").toLowerCase();
                if (promptNorm === reqNorm || promptNorm.indexOf(reqNorm.substring(0, 40)) === 0) {
                    fatal = "blocked: generateScriptFromPrompt called with original request as prompt. Use direct tools instead of a script generator for execution tasks.";
                }
            }
            if (outArgs.runNow === undefined) outArgs.runNow = false;
            if (outArgs.saveToLibrary === undefined) outArgs.saveToLibrary = true;
        }
        if (outTool === "generateExpressionFromPrompt") {
            if (outArgs.applyNow === undefined) outArgs.applyNow = false;
            if (outArgs.saveToLibrary === undefined) outArgs.saveToLibrary = true;
        }

        if (outTool === "applyEffect" && !hasString(outArgs.effectMatchName)) fatal = "missing effectMatchName";
        if ((outTool === "generateExpressionFromPrompt" || outTool === "generateScriptFromPrompt") && !hasString(outArgs.prompt)) fatal = "missing prompt";
        if (outTool === "executeExtendScript" && !hasString(outArgs.script)) fatal = "missing script";
        if (outTool === "runLibraryScript" && !hasString(outArgs.scriptName) && hasString(outArgs.name)) {
            outArgs.scriptName = outArgs.name;
            note("scriptName recovered from name");
        }
        if (outTool === "applyLibraryExpression" && !hasString(outArgs.expressionName) && hasString(outArgs.name)) {
            outArgs.expressionName = outArgs.name;
            note("expressionName recovered from name");
        }

        return { ok: fatal === "", fatal: fatal, tool: outTool, args: outArgs, notes: notes };
    }

    function enforceBridgePolicyOnPlan(normalized, analysisResult, maxCalls) {
        if (!normalized || !normalized.tool_calls || !(normalized.tool_calls instanceof Array)) return normalized;
        if (!analysisResult) return normalized;

        var needBridge = false;
        if (hasSkill(analysisResult, "expressionsSkill")) needBridge = true;
        if (analysisResult.complexityScore >= 18 || analysisResult.isHardMode || analysisResult.isGoldMode || analysisResult.isFathersMoneyMode) needBridge = true;
        if (!needBridge) return normalized;

        var hasBridge = false;
        for (var i = 0; i < normalized.tool_calls.length; i++) {
            if (isBridgeToolName(normalized.tool_calls[i].tool)) { hasBridge = true; break; }
        }
        if (hasBridge) return normalized;

        var bridgePrompt = (analysisResult.originalRequest && analysisResult.originalRequest !== "") ? analysisResult.originalRequest : "Build requested After Effects workflow.";
        var inserts = [];
        if (hasSkill(analysisResult, "expressionsSkill")) {
            inserts.push({
                tool: "generateExpressionFromPrompt",
                args: { prompt: bridgePrompt, applyNow: false, saveToLibrary: true }
            });
        }
        if (analysisResult.complexityScore >= 18 || analysisResult.isHardMode || analysisResult.isGoldMode || analysisResult.isFathersMoneyMode) {
            inserts.push({
                tool: "generateScriptFromPrompt",
                args: { prompt: bridgePrompt, runNow: false, saveToLibrary: true }
            });
        }

        if (inserts.length > 0) {
            normalized.tool_calls = inserts.concat(normalized.tool_calls);
            if (normalized.warnings) {
                normalized.warnings.push("Bridge policy injected " + inserts.length + " generator call(s) for deterministic hard-mode coverage.");
            }
            if (maxCalls && normalized.tool_calls.length > maxCalls) {
                normalized.tool_calls = normalized.tool_calls.slice(0, maxCalls);
                if (normalized.warnings) normalized.warnings.push("Bridge policy exceeded call budget; plan trimmed to " + maxCalls + ".");
            }
        }
        return normalized;
    }


// ============================================================
// SKILL ENGINE v3 — DETERMINISTIC, RECIPE-DRIVEN, PLAN-AWARE
//
// Architecture:
//   1. INTENT EXTRACTION — structured analysis of what the user wants
//   2. SKILL TRIGGERS — fast keyword-based skill detection
//   3. ANALYZE PROMPT — complexity + skill detection + mode routing
//   4. SKILL RECIPES — complete, correct tool call sequences per pattern
//   5. PLAN AUGMENTATION — holistic post-model plan improvement
//   6. SKILL CONTEXT BUILDER — prompt injection for model guidance
//   7. COMPLIANCE EVALUATOR — post-run quality scoring
//
// Key principles:
//   - Skills BUILD tool calls, not just suggest them via prompt text
//   - Context-aware: scans plan intent before touching anything
//   - Non-destructive: never overrides user-specified values without reason
//   - Targeted: only fires on the exact task type each skill serves
// ============================================================

    // ── INTENT EXTRACTION ──────────────────────────────────────────
    // Extracts structured, named intent from the prompt so every
    // downstream component can make context-aware decisions.
    function extractPromptIntent(promptText) {
        var lower = (promptText || "").toLowerCase();
        var intent = {
            // Task classification
            isDesignComposition: false,   // title card, motion graphic, slide, etc.
            isTechnicalEffects: false,    // effects/expressions on existing layers
            isLayerOrganization: false,   // parenting, labeling, ordering
            isTextHeavy: false,           // multiple text layers, typography focus
            isAnimationOnly: false,       // keyframes/motion on existing work
            isFullBuild: false,           // building a comp from scratch
            isEditExisting: false,        // modifying what's already in the comp

            // Content signals
            wantsBackground: false,       // background layer explicitly mentioned
            wantsText: false,             // text/title/headline requested
            wantsAnimation: false,        // motion requested
            wantsColorGrade: false,       // color grading/LUT requested
            wantsCameraMove: false,       // camera animation
            wantsExpressions: false,      // expressions/wiggle/loops

            // Style signals
            wantsDarkTheme: false,        // dark/night/dark mode
            wantsLightTheme: false,       // light/clean/white
            wantsVivid: false,            // vivid/colorful/bright
            wantsMinimal: false,          // minimal/clean/simple

            // Detected motion patterns (for recipe matching)
            motionPatterns: [],           // e.g. ["fadeIn","slideUp","stagger"]

            // Timing hints (seconds)
            estimatedDuration: 5,
            staggerAmount: 0.17,

            // Raw lower
            lower: lower
        };

        // Task type detection
        var designWords = ["title card","lower third","motion graphic","intro","outro","end card",
            "bumper","sting","promo","explainer","presentation","slide","opener","broadcast","logo reveal",
            "title sequence","name tag","caption","overlay","graphics package","social post","thumbnail"];
        var technicalWords = ["apply effect","add effect","wiggle","expression","gradient ramp","fractal noise",
            "apply lumetri","color correction","blend mode","track matte","luma matte","distort","blur","glow effect",
            // gradient variants — "add a gradient", "gradient fill", "gradient background", "gradient overlay"
            "add a gradient","gradient fill","gradient background","gradient overlay","gradient on",
            "gradient to","linear gradient","radial gradient",
            // common effect requests that don't use the word "effect"
            "add glow","add blur","add shadow","drop shadow","add noise","add tint","add fill",
            "color grade","add ramp","add vignette","chromatic aberration","add grain","lens flare"];
        var buildWords = ["create","build","make","design","set up","put together","from scratch","new comp"];
        var editWords = ["change","update","fix","adjust","modify","edit","rename","move","replace","tweak"];

        for (var d = 0; d < designWords.length; d++) if (lower.indexOf(designWords[d]) !== -1) { intent.isDesignComposition = true; break; }
        for (var te = 0; te < technicalWords.length; te++) if (lower.indexOf(technicalWords[te]) !== -1) { intent.isTechnicalEffects = true; break; }
        for (var b = 0; b < buildWords.length; b++) if (lower.indexOf(buildWords[b]) !== -1) { intent.isFullBuild = true; break; }
        for (var e = 0; e < editWords.length; e++) if (lower.indexOf(editWords[e]) !== -1) { intent.isEditExisting = true; break; }

        // Content signals
        if (lower.match(/\bbg\b|background|backdrop|canvas/)) intent.wantsBackground = true;
        if (lower.match(/\btext\b|title|heading|headline|subtitle|caption|label|name|word/)) intent.wantsText = true;
        if (lower.match(/animat|keyframe|fade|slide|wipe|reveal|entrance|exit|motion|transition/)) intent.wantsAnimation = true;
        if (lower.match(/color grade|colour grade|lut|lumetri|color correct|grade$/)) intent.wantsColorGrade = true;
        if (lower.match(/camera|dolly|push in|pull back|orbit|pan|3d move/)) intent.wantsCameraMove = true;
        if (lower.match(/expression|wiggle|loopout|loopin|link.*layer|driven by/)) intent.wantsExpressions = true;

        // Style signals
        if (lower.match(/dark|night|black|deep|moody|cinematic|premium/)) intent.wantsDarkTheme = true;
        if (lower.match(/light|white|clean|bright|minimal|airy/)) intent.wantsLightTheme = true;
        if (lower.match(/vivid|colorful|vibrant|bold color|neon|pop/)) intent.wantsVivid = true;
        if (lower.match(/minimal|simple|clean|flat|understated/)) intent.wantsMinimal = true;

        // Derive composite intents
        intent.isDesignComposition = intent.isDesignComposition || (intent.wantsText && intent.wantsBackground && intent.isFullBuild);
        intent.isTextHeavy = (lower.match(/\btitle\b|\bheadline\b|\bheading\b|\btext\b/g) || []).length >= 2;
        intent.isAnimationOnly = intent.wantsAnimation && !intent.isFullBuild && !intent.isDesignComposition;

        // Motion pattern detection
        if (lower.match(/fade.?in|opacity.*0.*to.*100|0.*opacity/)) intent.motionPatterns.push("fadeIn");
        if (lower.match(/fade.?out|opacity.*100.*to.*0/)) intent.motionPatterns.push("fadeOut");
        if (lower.match(/slide.*up|from.*below|bottom.*to.*top/)) intent.motionPatterns.push("slideUp");
        if (lower.match(/slide.*down|from.*above|top.*to.*bottom/)) intent.motionPatterns.push("slideDown");
        if (lower.match(/slide.*left|from.*right/)) intent.motionPatterns.push("slideLeft");
        if (lower.match(/slide.*right|from.*left/)) intent.motionPatterns.push("slideRight");
        if (lower.match(/scale.*reveal|scale.*in|grow.*in|pop.*in/)) intent.motionPatterns.push("scaleReveal");
        if (lower.match(/stagger|one.*by.*one|sequentially|cascade/)) intent.motionPatterns.push("stagger");
        if (lower.match(/trim.*path|draw.*on|write.*on|line.*reveal/)) intent.motionPatterns.push("trimPath");
        if (lower.match(/typewriter|type.*out|letter.*by.*letter/)) intent.motionPatterns.push("typewriter");
        if (lower.match(/spin|rotate.*in|360/)) intent.motionPatterns.push("rotateIn");
        if (lower.match(/bounce|elastic|overshoot/)) intent.motionPatterns.push("bounce");

        // Timing hints
        var durationMatch = lower.match(/(\d+(?:\.\d+)?)\s*second/);
        if (durationMatch) intent.estimatedDuration = parseFloat(durationMatch[1]);
        var staggerMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:second|s)\s*(?:apart|stagger|delay)/);
        if (staggerMatch) intent.staggerAmount = parseFloat(staggerMatch[1]);

        return intent;
    }

    // ── SKILL RECIPES ─────────────────────────────────────────────
    // Each recipe is a function that returns an array of tool calls.
    // These are REAL tool calls — deterministic, complete, correct.
    // The plan augmenter calls these to fill gaps in the model's plan.
    var SKILL_RECIPES = {

        // BG solid — dark, near-black, always first layer
        darkBackground: function(compName) {
            return [
                { tool: "createSolidLayer", args: { compName: compName, name: "BG", color: [0.05, 0.05, 0.05, 1] } },
                { tool: "setLayerLabel", args: { compName: compName, layerName: "BG", label: "red" } }
            ];
        },

        // Accent bar — slides in from left, hold, slides out
        accentBarReveal: function(compName, color, y, startTime) {
            color = color || [0.95, 0.38, 0.18, 1];
            y = (y !== undefined) ? y : 460;
            startTime = startTime || 0.2;
            return [
                { tool: "createShapeLayer", args: { compName: compName, name: "AccentBar", shapeType: "rectangle", size: [280, 3], position: [960, y], fillColor: color } },
                { tool: "addKeyframe", args: { compName: compName, layerName: "AccentBar", property: "scale", time: startTime, value: [0, 100] } },
                { tool: "addKeyframe", args: { compName: compName, layerName: "AccentBar", property: "scale", time: startTime + 0.5, value: [100, 100] } },
                { tool: "setKeyframeInterpolation", args: { compName: compName, layerName: "AccentBar", property: "scale", allKeys: true, inType: "easeIn", outType: "easeOut" } },
                { tool: "setLayerLabel", args: { compName: compName, layerName: "AccentBar", label: "orange" } }
            ];
        },

        // Fade in a layer: opacity 0 → 100
        fadeIn: function(compName, layerName, startTime, duration) {
            startTime = startTime || 0;
            duration = duration || 0.5;
            return [
                { tool: "addKeyframe", args: { compName: compName, layerName: layerName, property: "opacity", time: startTime, value: 0 } },
                { tool: "addKeyframe", args: { compName: compName, layerName: layerName, property: "opacity", time: startTime + duration, value: 100 } },
                { tool: "setKeyframeInterpolation", args: { compName: compName, layerName: layerName, property: "opacity", allKeys: true, inType: "easeIn", outType: "easeOut" } }
            ];
        },

        // Slide up reveal: position slides up while fading in
        slideUpReveal: function(compName, layerName, finalX, finalY, startTime, duration) {
            startTime = startTime || 0;
            duration = duration || 0.6;
            var fromY = finalY + 40;
            return [
                { tool: "addKeyframe", args: { compName: compName, layerName: layerName, property: "opacity", time: startTime, value: 0 } },
                { tool: "addKeyframe", args: { compName: compName, layerName: layerName, property: "opacity", time: startTime + duration * 0.8, value: 100 } },
                { tool: "addKeyframe", args: { compName: compName, layerName: layerName, property: "position", time: startTime, value: [finalX, fromY] } },
                { tool: "addKeyframe", args: { compName: compName, layerName: layerName, property: "position", time: startTime + duration, value: [finalX, finalY] } },
                { tool: "setKeyframeInterpolation", args: { compName: compName, layerName: layerName, property: "position", allKeys: true, inType: "easeIn", outType: "easeOut" } },
                { tool: "setKeyframeInterpolation", args: { compName: compName, layerName: layerName, property: "opacity", allKeys: true, inType: "easeIn", outType: "easeOut" } }
            ];
        },

        // Scale reveal: scale 0 → 100 with easing (logo reveal, pop-in)
        scaleReveal: function(compName, layerName, startTime, duration) {
            startTime = startTime || 0;
            duration = duration || 0.45;
            return [
                { tool: "addKeyframe", args: { compName: compName, layerName: layerName, property: "scale", time: startTime, value: [0, 0] } },
                { tool: "addKeyframe", args: { compName: compName, layerName: layerName, property: "scale", time: startTime + duration, value: [100, 100] } },
                { tool: "setKeyframeInterpolation", args: { compName: compName, layerName: layerName, property: "scale", allKeys: true, inType: "easeIn", outType: "easeOut" } }
            ];
        },

        // Color grade adjustment layer (always goes on top)
        colorGrade: function(compName) {
            return [
                { tool: "addAdjustmentLayer", args: { compName: compName, name: "Color Grade" } },
                { tool: "applyEffect", args: { compName: compName, layerName: "Color Grade", effectMatchName: "ADBE Lumetri" } },
                { tool: "setLayerLabel", args: { compName: compName, layerName: "Color Grade", label: "yellow" } }
            ];
        },

        // Vignette layer (ellipse shape, multiply blend)
        vignette: function(compName) {
            return [
                { tool: "createShapeLayer", args: { compName: compName, name: "Vignette", shapeType: "ellipse", size: [2560, 2560], fillColor: [0, 0, 0, 1] } },
                { tool: "setLayerProperties", args: { compName: compName, layerName: "Vignette", opacity: 55, blendMode: "multiply" } },
                { tool: "setLayerLabel", args: { compName: compName, layerName: "Vignette", label: "gray" } }
            ];
        },

        // Wiggle expression on a property
        wiggle: function(compName, layerName, property, freq, amp) {
            freq = freq || 2;
            amp = amp || 8;
            return [
                { tool: "applyExpression", args: { compName: compName, layerName: layerName, property: property, expression: "wiggle(" + freq + ", " + amp + ")" } }
            ];
        },

        // Loop expression on a property
        loop: function(compName, layerName, property) {
            return [
                { tool: "applyExpression", args: { compName: compName, layerName: layerName, property: property, expression: "loopOut('cycle')" } }
            ];
        },

        // Stagger entrance for N layers: returns calls for all of them
        staggerFadeIn: function(compName, layerNames, startTime, staggerGap, duration) {
            staggerGap = staggerGap || 0.17;
            duration = duration || 0.5;
            var calls = [];
            for (var i = 0; i < layerNames.length; i++) {
                var t = (startTime || 0) + (i * staggerGap);
                var recipe = SKILL_RECIPES.fadeIn(compName, layerNames[i], t, duration);
                for (var r = 0; r < recipe.length; r++) calls.push(recipe[r]);
            }
            return calls;
        },

        // Easing injection: inject setKeyframeInterpolation for every addKeyframe
        // that doesn't already have one in the call list
        injectMissingEasing: function(calls) {
            var keyed = {};    // key → {compName,layerName,property}
            var interped = {}; // key → true
            for (var i = 0; i < calls.length; i++) {
                var tool = calls[i].tool || "";
                var args = calls[i].args || {};
                if (tool === "addKeyframe" && args.layerName && args.property) {
                    var k = (args.compName || "") + "|" + args.layerName + "|" + args.property;
                    keyed[k] = { compName: args.compName, layerName: args.layerName, property: args.property };
                }
                if (tool === "setKeyframeInterpolation" && args.layerName && args.property) {
                    var ik = (args.compName || "") + "|" + args.layerName + "|" + args.property;
                    interped[ik] = true;
                }
            }
            var injected = [];
            for (var k2 in keyed) {
                if (keyed.hasOwnProperty(k2) && !interped[k2]) {
                    var kt = keyed[k2];
                    injected.push({
                        tool: "setKeyframeInterpolation",
                        args: { compName: kt.compName, layerName: kt.layerName, property: kt.property,
                                allKeys: true, inType: "easeIn", outType: "easeOut", inInfluence: 50, outInfluence: 70 }
                    });
                }
            }
            return injected;
        }
    };

    // ── SKILL TRIGGERS ─────────────────────────────────────────────
    var SKILL_TRIGGERS = {
        motionGraphics: [
            // Explicit motion graphics vocabulary
            "motion graphic","title card","lower third","intro","outro","end card","bumper","sting",
            "promo","explainer","broadcast","logo animation","icon animation","opener","title sequence",
            "kinetic","animated text","reveal",
            // Design quality signals
            "pretty","beautiful","polished","cinematic","slick","professional","good looking",
            "nice looking","clean","elegant","aesthetic","stylish","make it pop","make it nice",
            "look and feel","social media","instagram","youtube","reels","tiktok","shorts","presentation",
            // Generic animation intent — catches "animate X", "make it animated"
            "animate","animation","motion","animated","transition","fade in","fade out","slide in",
            "wipe","dissolve","fly in","fly out","entrance","smooth","juicy","snappy","bounce","spring","stagger",
            // Looping content
            "loop animation","seamless loop","lottie","looping","seamlessly","repeating animation"
        ],
        visualDesign: [
            "infographic","dashboard","data visualization","chart","graph","layout","grid","card",
            "ui design","interface","icon set","brand identity","style guide","design system",
            "color scheme","font pairing","visual hierarchy","thumbnail","banner","poster",
            "social graphic","mockup","composition","premium look","high-end look","brand","identity"
        ],
        typography: [
            // Explicit type vocabulary
            "title","heading","headline","font","typeface","text animation","kinetic type",
            "lower third","font size","font weight","letter spacing","line height","tracking",
            "serif","sans-serif","subheading","caption","font pairing","legibility","type hierarchy",
            "typographic","bold text","kerning","type scale","google fonts",
            // Common text operations — "add a text layer", "create text", etc.
            "text layer","add text","create text","write text","text with","display text",
            "show text","text that says","subtitle","label"
        ],
        designPrinciples: [
            "contrast","hierarchy","balance","proximity","repetition","whitespace","negative space",
            "rule of thirds","golden ratio","focal point","visual weight","asymmetry","symmetry",
            "grid layout","minimal","clean design","breathing room","crap principle"
        ],
        compositing: [
            "composite","compositing","green screen","chroma key","keying","light wrap",
            "track matte","luma matte","blend mode","multiply","screen mode","footage",
            "live action","vfx","visual effect","seamless blend","film grain","chromatic"
        ],
        expressionsSkill: [
            "expression","wiggle","loopout","loopin","loop out","loop in","time remapping",
            "look at","posterizetime","thiscomp.layer","expression rig","driven by","linked to",
            "expression control","slider control","automate","procedural","random","noise",
            // Data-driven / responsive
            "data driven","data-driven","responsive","dynamic value","link layer","connect layer",
            "master control","control layer","expression link","drive with","controlled by"
        ],
        spatial3D: [
            "3d layer","camera","z position","z depth","parallax","camera move","dolly",
            "push in","pull back","point of interest","orbit","pan camera","perspective",
            "vanishing point","3d space","2.5d","parallax scroll","light layer",
            "ambient light","spot light","point light","3d","depth"
        ],
        animation12: [
            "squash","stretch","anticipation","ease","secondary action","follow through",
            "overlapping action","staging","exaggerate","weight","momentum","overshoot","settle",
            "bouncy","elastic","feels alive","organic motion","gravity","inertia","snappy","punchy",
            "12 principles","animation principles","keyframe","ease in","ease out","interpolation",
            "smooth motion","spring","damping","add keyframes"
        ],
        colorTheory: [
            "color palette","color harmony","complementary","analogous","triadic","color grade",
            "color grading","lut","color space","hue","saturation","luminance","color temperature",
            "warm tone","cool tone","teal and orange","cinematic grade","color correction",
            "desaturate","monochromatic","split tone","color mood","color wheel"
        ]
    };

    // ── ANALYZE PROMPT ─────────────────────────────────────────────
    function analyzePrompt(promptText) {
        var lower = (promptText || "").toLowerCase();
        var result = {
            originalRequest: promptText || "",
            intent: extractPromptIntent(promptText),
            skills: [],
            complexityScore: 0,
            isHardMode: false,
            isGoldMode: false,
            isFathersMoneyMode: false,
            modelTier: "small",
            estimatedToolCalls: 0,
            hints: []
        };

        // ── Skill detection via triggers ──────────────────────────
        for (var sk in SKILL_TRIGGERS) {
            if (!SKILL_TRIGGERS.hasOwnProperty(sk)) continue;
            var triggers = SKILL_TRIGGERS[sk];
            for (var t = 0; t < triggers.length; t++) {
                if (lower.indexOf(triggers[t]) !== -1) {
                    result.skills.push(sk);
                    break;
                }
            }
        }

        // ── Smart cascade ─────────────────────────────────────────
        // Only cascade to supporting skills when there are strong signals.
        // Never dump all skills onto a simple technical task.
        function ensureSkill(key) {
            for (var si0 = 0; si0 < result.skills.length; si0++) if (result.skills[si0] === key) return;
            result.skills.push(key);
        }
        function hasS(key) {
            for (var si1 = 0; si1 < result.skills.length; si1++) if (result.skills[si1] === key) return true;
            return false;
        }
        var hasMotion = hasS("motionGraphics");
        var hasVisual = hasS("visualDesign");
        var hasType   = hasS("typography");

        // Full design cascade: motion + typography together, or explicit visual design
        if ((hasMotion && hasType) || hasVisual) {
            ensureSkill("designPrinciples");
            ensureSkill("colorTheory");
            if (!hasType) ensureSkill("typography");
        }
        // Animation polish always accompanies motion graphics
        if (hasMotion) ensureSkill("animation12");

        // ── Complexity scoring ───────────────────────────────────
        var wordCount = (promptText || "").split(/\s+/).length;
        result.complexityScore += Math.floor(wordCount / 8);

        var complexWords = ["animation","animate","keyframe","effect","expression","layer","multiple","each","all",
            "every","group","parent","precompose","stagger","sequence","loop","repeat","transition","morph",
            "gradient","shape","path","mask","text animator","counter","distribute","align","grid","scatter",
            "parallax","camera","light","3d","depth","glow","blur","distort","noise","adjustment","solid",
            "null","control","rig","system","scene","intro","outro","full video","full comp","package"];
        for (var ki = 0; ki < complexWords.length; ki++) {
            if (lower.indexOf(complexWords[ki]) !== -1) result.complexityScore++;
        }
        var numMatches = promptText.match(/\b([3-9]|[1-9]\d)\s+(layer|scene|card|item|element|text|shape)/gi);
        if (numMatches) result.complexityScore += numMatches.length * 3;
        if (lower.indexOf("every layer") !== -1 || lower.indexOf("all layers") !== -1) result.complexityScore += 5;
        if (lower.indexOf("stagger") !== -1) result.complexityScore += 3;
        if (lower.indexOf("expression") !== -1 || lower.indexOf("wiggle") !== -1) result.complexityScore += 2;
        if (lower.indexOf("system") !== -1 || lower.indexOf("rig") !== -1) result.complexityScore += 4;

        var hardWords = ["complex","advanced","full scene","full animation","complete","entire","everything",
            "whole","comprehensive","elaborate","detailed","intricate","from scratch","full package","build me"];
        for (var hk = 0; hk < hardWords.length; hk++) {
            if (lower.indexOf(hardWords[hk]) !== -1) { result.complexityScore += 5; break; }
        }
        if (lower.indexOf("hard mode") !== -1) result.complexityScore += 5;
        if (lower.indexOf("gold mode") !== -1) result.complexityScore += 7;
        if (lower.indexOf("autonomous") !== -1 || lower.indexOf("fully automatic") !== -1) result.complexityScore += 4;

        // ── Mode detection ───────────────────────────────────────
        var fatherHit = lower.indexOf("father money") !== -1 || lower.indexOf("father's money") !== -1 ||
            lower.indexOf("super hard mode") !== -1 || lower.indexOf("no limit on api") !== -1 ||
            uiState.agentFathersMoneyModeEnabled === true;
        if (fatherHit) { result.isFathersMoneyMode = true; result.complexityScore += 15; }

        result.isHardMode = result.complexityScore >= 12 || result.isFathersMoneyMode;
        result.isGoldMode = result.complexityScore >= 20 || result.isFathersMoneyMode;

        if (result.isFathersMoneyMode) result.modelTier = "max";
        else if (result.isGoldMode) result.modelTier = "large";
        else if (result.isHardMode || result.complexityScore >= 9) result.modelTier = "medium";
        else result.modelTier = "small";

        result.estimatedToolCalls = result.isFathersMoneyMode
            ? Math.min(40 + result.complexityScore * 2, 140)
            : Math.min(2 + result.complexityScore, 100);

        // ── FMM: merge all skills ────────────────────────────────
        if (result.isFathersMoneyMode) {
            var allSkills = ["motionGraphics","visualDesign","typography","designPrinciples",
                "compositing","expressionsSkill","spatial3D","animation12","colorTheory"];
            for (var ai = 0; ai < allSkills.length; ai++) ensureSkill(allSkills[ai]);
        } else {
            applyAgentSkillToggles(result);
        }

        // ── Hints for UI ─────────────────────────────────────────
        if (result.isFathersMoneyMode) result.hints.push("Father's Money Mode");
        else if (result.isGoldMode) result.hints.push("Gold Mode (score:" + result.complexityScore + ")");
        else if (result.isHardMode) result.hints.push("Hard Mode (score:" + result.complexityScore + ")");
        var skillHintMap = {
            motionGraphics:"Design", visualDesign:"Layout", typography:"Typography",
            designPrinciples:"Principles", compositing:"Compositing", expressionsSkill:"Expressions",
            spatial3D:"3D/Camera", animation12:"Animation", colorTheory:"Color"
        };
        for (var si = 0; si < result.skills.length; si++) {
            var hn = skillHintMap[result.skills[si]];
            if (hn) result.hints.push(hn + " skill");
        }

        return result;
    }

    function agentSkillDisplayName(skillKey) {
        var map = { motionGraphics:"Design", visualDesign:"Layout", typography:"Typography",
            designPrinciples:"Principles", compositing:"Compositing", expressionsSkill:"Expressions",
            spatial3D:"3D/Camera", animation12:"Animation", colorTheory:"Color Theory" };
        return map[skillKey] || skillKey || "";
    }

    function buildAgentSkillBadgeText(skills, compact) {
        var names = [];
        for (var i = 0; i < (skills || []).length; i++) {
            var n = agentSkillDisplayName(skills[i]);
            if (compact && n === "Design Principles") n = "Principles";
            if (compact && n === "3D/Camera") n = "3D/Cam";
            names.push(n);
        }
        return names.length > 0 ? (names.join(" + ") + " skill" + (names.length > 1 ? "s" : "")) : "";
    }

    function getAgentSkillToggleMap() {
        // Read from persisted uiState so per-skill toggles are respected
        return {
            motionGraphics:    (uiState.agentSkillMotionEnabled       !== false),
            visualDesign:      (uiState.agentSkillVisualEnabled       !== false),
            typography:        (uiState.agentSkillTypographyEnabled   !== false),
            designPrinciples:  (uiState.agentSkillDesignPrinciplesEnabled !== false),
            compositing:       (uiState.agentSkillCompositingEnabled  !== false),
            expressionsSkill:  (uiState.agentSkillExpressionsEnabled  !== false),
            spatial3D:         (uiState.agentSkillSpatial3DEnabled    !== false),
            animation12:       (uiState.agentSkillAnimation12Enabled  !== false),
            colorTheory:       (uiState.agentSkillColorTheoryEnabled  !== false)
        };
    }

    function applyAgentSkillToggles(analysis) {
        if (!analysis) return analysis;
        var enabled = getAgentSkillToggleMap();
        var filtered = [], disabledHits = [];
        for (var i = 0; i < (analysis.skills || []).length; i++) {
            var s = analysis.skills[i];
            if (enabled[s] === false) disabledHits.push(s);
            else filtered.push(s);
        }
        analysis.skills = filtered;
        analysis.disabledSkillHits = disabledHits;
        return analysis;
    }

    // ── PLAN AUGMENTATION (replaces applySkillActionsToPlanCalls) ──
    // This is where skills actually DO things.
    // Approach: scan the model's plan holistically → understand what kind of task it is
    // → apply targeted fixes in-place → inject missing elements at correct positions.
    function applySkillActionsToPlanCalls(calls, analysisResult) {
        var out = [];
        for (var ci = 0; ci < calls.length; ci++) out.push(calls[ci]);

        var notes = [];
        var intent = (analysisResult && analysisResult.intent) ? analysisResult.intent : extractPromptIntent(analysisResult ? analysisResult.originalRequest || "" : "");

        var isDesign   = hasSkill(analysisResult, "motionGraphics") || hasSkill(analysisResult, "visualDesign") || hasSkill(analysisResult, "designPrinciples");
        var isType     = hasSkill(analysisResult, "typography");
        var isAnim     = hasSkill(analysisResult, "animation12") || hasSkill(analysisResult, "motionGraphics");
        var isColor    = hasSkill(analysisResult, "colorTheory") || hasSkill(analysisResult, "visualDesign");
        var isExpr     = hasSkill(analysisResult, "expressionsSkill");
        var isComp     = hasSkill(analysisResult, "compositing");

        if (!isDesign && !isType && !isAnim && !isColor && !isExpr && !isComp) {
            return { calls: out, notes: ["No skills active — pass-through."] };
        }

        // ── PRE-SCAN: build a complete picture of the plan ─────────
        var scan = {
            textLayers: [],     // { idx, name, compName, hasFont, hasFontSize, hasColor, hasPosition }
            solidLayers: [],    // { idx, name, compName, hasColor }
            shapeLayers: [],    // { idx, name, compName, hasFill }
            nullLayers: [],
            adjLayers: [],
            keyframedProps: {}, // "compName|layerName|property" → true
            interpedProps: {},  // "compName|layerName|property" → true
            effectCalls: [],    // { idx, layerName, effectName }
            exprCalls: [],
            labeledLayers: {}, // "compName|layerName" → true
            hasBG: false,
            hasColorGrade: false,
            compNames: {}
        };

        for (var i = 0; i < out.length; i++) {
            var tool = out[i].tool || "";
            var args = out[i].args || {};
            var cname = args.compName || "";
            if (cname) scan.compNames[cname] = true;

            if (tool === "createTextLayer") {
                scan.textLayers.push({ idx: i, name: args.name || ("Text:"+(args.text||"").substr(0,20)), compName: cname,
                    hasFont: !!(args.fontName), hasFontSize: !!(args.fontSize), hasColor: !!(args.color),
                    hasPosition: !!(args.position), text: args.text || "" });
            }
            if (tool === "createSolidLayer") {
                var isBG = !args.color || (args.color[0] < 0.12 && args.color[1] < 0.12 && args.color[2] < 0.12);
                scan.solidLayers.push({ idx: i, name: args.name || "Solid", compName: cname, hasColor: !!(args.color || args.fillColor), isBG: isBG });
                if (isBG) scan.hasBG = true;
            }
            if (tool === "createShapeLayer") scan.shapeLayers.push({ idx: i, name: args.name || "Shape", compName: cname, hasFill: !!(args.fillColor) });
            if (tool === "createNullLayer") scan.nullLayers.push({ idx: i, name: args.name || "Null", compName: cname });
            if (tool === "addAdjustmentLayer") { scan.adjLayers.push({ idx: i, name: args.name || "Adj", compName: cname }); if ((args.name||"").toLowerCase().indexOf("grade") !== -1 || (args.name||"").toLowerCase().indexOf("color") !== -1) scan.hasColorGrade = true; }
            if (tool === "applyEffect" || tool === "applyEffectPreset") { scan.effectCalls.push({ idx: i, layerName: args.layerName, effectName: args.effectMatchName || args.effectDisplayName || "" }); if ((args.effectMatchName||"").indexOf("Lumetri") !== -1) scan.hasColorGrade = true; }
            if (tool === "applyExpression" || tool === "applyLibraryExpression" || tool === "generateExpressionFromPrompt") scan.exprCalls.push({ idx: i, layerName: args.layerName });
            if (tool === "addKeyframe" && args.layerName && args.property) { var kk = cname+"|"+args.layerName+"|"+args.property; scan.keyframedProps[kk] = { compName: cname, layerName: args.layerName, property: args.property }; }
            if (tool === "setKeyframeInterpolation" && args.layerName && args.property) { var ik = cname+"|"+args.layerName+"|"+args.property; scan.interpedProps[ik] = true; }
            if (tool === "setLayerLabel" && args.layerName) scan.labeledLayers[(cname+"|"+args.layerName).toLowerCase()] = true;
        }

        var totalLayers = scan.textLayers.length + scan.solidLayers.length + scan.shapeLayers.length;
        var hasEffects  = scan.effectCalls.length > 0 || scan.exprCalls.length > 0;

        // Task type classification from plan content (not just keyword triggers)
        // This is the crucial guard against over-applying skills to technical tasks.
        var planIsDesignProject  = scan.textLayers.length >= 1 && totalLayers >= 2;
        var planIsTextOnly       = scan.textLayers.length >= 1 && scan.solidLayers.length === 0 && scan.shapeLayers.length === 0;
        var planIsTechnicalWork  = hasEffects && scan.textLayers.length === 0 && totalLayers <= 3;
        var planHasKeyframes = (function(obj) { for (var _k in obj) { if (obj.hasOwnProperty(_k)) return true; } return false; })(scan.keyframedProps);
        var planIsAnimationOnly  = planHasKeyframes && totalLayers === 0;

        // If it's pure technical effects work on a small number of layers — stand down from design enforcement
        if (planIsTechnicalWork) {
            isDesign = false;
            isType   = false;
            isColor  = false;
            notes.push("Effects task detected — design/color enforcement skipped, easing only.");
        }

        // ── IN-PLACE FIXES: correct what the model got wrong ───────
        var typographyPatched = 0;
        var colorPatched = 0;
        var textSeen = 0;

        for (var j = 0; j < out.length; j++) {
            var t2 = out[j].tool || "";
            var a2 = out[j].args || {};

            // ── TYPOGRAPHY FIX ──
            if (t2 === "createTextLayer" && isType) {
                var role = textSeen++;
                // Font: always enforce Montserrat (model frequently picks Arial, Helvetica, or nothing)
                if (!a2.fontName || a2.fontName.toLowerCase().indexOf("montserrat") === -1) {
                    a2.fontName = role === 0 ? "Montserrat-Bold" : "Montserrat";
                    typographyPatched++;
                }
                // Size: enforce hierarchy — model often uses identical sizes for all text
                if (role === 0) {
                    if (!a2.fontSize || a2.fontSize < 96) { a2.fontSize = 96; typographyPatched++; }
                    a2.alignment = "center";
                    a2.bold = true;
                    if (!a2.color) { a2.color = [0.96, 0.96, 0.95, 1]; colorPatched++; }
                } else if (role === 1) {
                    if (!a2.fontSize || a2.fontSize < 48 || a2.fontSize > 64) { a2.fontSize = 52; typographyPatched++; }
                    a2.alignment = "center";
                    if (!a2.color) { a2.color = [0.75, 0.75, 0.73, 1]; colorPatched++; }
                } else {
                    if (!a2.fontSize || a2.fontSize > 36) { a2.fontSize = 28; typographyPatched++; }
                    if (!a2.color) { a2.color = [0.6, 0.6, 0.58, 1]; colorPatched++; }
                }
            }

            // ── COLOR FIX: background solid on design projects ──
            if (t2 === "createSolidLayer" && isDesign && planIsDesignProject) {
                // Only touch first solid that has no color — make it the BG
                if (!a2.color && !a2.fillColor) {
                    a2.color = [0.05, 0.05, 0.05, 1];
                    a2.name  = a2.name || "BG";
                    colorPatched++;
                }
            }

            // ── SHAPE FILL on design projects ──
            if (t2 === "createShapeLayer" && isDesign && planIsDesignProject && !a2.fillColor) {
                var nm2 = (a2.name || "").toLowerCase();
                a2.fillColor = (nm2.indexOf("accent") !== -1 || nm2.indexOf("bar") !== -1 || nm2.indexOf("line") !== -1)
                    ? [0.95, 0.38, 0.18, 1]
                    : [0.13, 0.13, 0.13, 1];
                colorPatched++;
            }
        }

        if (typographyPatched > 0) notes.push("Typography: fixed " + typographyPatched + " text property(ies).");
        if (colorPatched > 0)      notes.push("Color: applied palette to " + colorPatched + " layer(s).");

        // ── PASS 2: AUGMENT — inject what's missing ─────────────────
        // These are the recipe-driven additions that make the plan actually complete.
        // They are added to a separate augmentation list, then inserted at the right
        // position in the plan (not just appended at the end).

        var augHead = []; // injected at the very start of the plan
        var augTail = []; // appended at the end of the plan

        // 1. BACKGROUND: design project has no BG solid → inject one at position 0
        if (isDesign && planIsDesignProject && !scan.hasBG && scan.solidLayers.length === 0) {
            var bgComp = (scan.solidLayers.length === 0 && scan.textLayers.length > 0)
                ? scan.textLayers[0].compName
                : (function(obj) { for (var _k in obj) { if (obj.hasOwnProperty(_k)) return _k; } return null; })(scan.compNames);
            var bgCalls = SKILL_RECIPES.darkBackground(bgComp);
            for (var bc = 0; bc < bgCalls.length; bc++) augHead.push(bgCalls[bc]);
            scan.hasBG = true;
            notes.push("Design: injected dark background at position 0.");
        }

        // 2. LAYER LABELS: design project with unlabeled layers → label by role
        if (isDesign && planIsDesignProject) {
            var labelsAdded = 0;
            var labelMap = {
                createTextLayer: function(idx) { var r = 0; for (var li = 0; li < idx; li++) if (out[li].tool === "createTextLayer") r++; return r === 0 ? "blue" : (r === 1 ? "violet" : "indigo"); },
                createSolidLayer: function() { return "red"; },
                createShapeLayer: function() { return "green"; },
                createNullLayer: function() { return "purple"; },
                addAdjustmentLayer: function() { return "yellow"; }
            };
            var allCreates = scan.textLayers.concat(scan.solidLayers).concat(scan.shapeLayers).concat(scan.nullLayers).concat(scan.adjLayers);
            for (var la = 0; la < allCreates.length; la++) {
                var info = allCreates[la];
                var lkc = (info.compName + "|" + info.name).toLowerCase();
                if (scan.labeledLayers[lkc]) continue;
                var layerTool = out[info.idx].tool;
                var lbl = labelMap[layerTool] ? labelMap[layerTool](info.idx) : "cyan";
                augTail.push({ tool: "setLayerLabel", args: { compName: info.compName, layerName: info.name, label: lbl } });
                scan.labeledLayers[lkc] = true;
                labelsAdded++;
            }
            if (labelsAdded > 0) notes.push("Design: labeled " + labelsAdded + " layer(s) by role.");
        }

        // 3. EASING: inject setKeyframeInterpolation for every keyframed property missing one
        // This is the single most impactful and always-correct enforcement.
        var easingAdded = 0;
        for (var ke in scan.keyframedProps) {
            if (!scan.keyframedProps.hasOwnProperty(ke)) continue;
            if (scan.interpedProps[ke]) continue;
            var kd = scan.keyframedProps[ke];
            if (!kd.layerName || !kd.property) continue;
            augTail.push({ tool: "setKeyframeInterpolation", args: {
                compName: kd.compName, layerName: kd.layerName, property: kd.property,
                allKeys: true, inType: "easeIn", outType: "easeOut", inInfluence: 50, outInfluence: 70
            }});
            easingAdded++;
        }
        if (easingAdded > 0) notes.push("Animation: injected easing on " + easingAdded + " keyframed propert" + (easingAdded > 1 ? "ies" : "y") + ".");

        // 4. COLOR GRADE: design project that requested color grade but has no adjustment layer
        if (isDesign && planIsDesignProject && intent.wantsColorGrade && !scan.hasColorGrade) {
            var gradeComp = scan.textLayers.length > 0 ? scan.textLayers[0].compName : (function(obj) { for (var _k in obj) { if (obj.hasOwnProperty(_k)) return _k; } return null; })(scan.compNames);
            var gradeCalls = SKILL_RECIPES.colorGrade(gradeComp);
            for (var gc = 0; gc < gradeCalls.length; gc++) augTail.push(gradeCalls[gc]);
            notes.push("Color: added color grade adjustment layer.");
        }

        // 5. ANIMATION: if design project has text layers but NO keyframes at all, add entrance animations
        // Only if the user asked for animation (intent.wantsAnimation) and nothing was animated
        if (isAnim && planIsDesignProject && intent.wantsAnimation && !planHasKeyframes) {
            var animComp = scan.textLayers.length > 0 ? scan.textLayers[0].compName : null;
            if (animComp) {
                var staggerT = 0;
                var allAnimNames = [];
                for (var tl = 0; tl < scan.textLayers.length; tl++) allAnimNames.push(scan.textLayers[tl].name);
                // Use motion pattern if detected, otherwise default to slideUp
                var usePattern = intent.motionPatterns.length > 0 ? intent.motionPatterns[0] : "slideUp";
                var animCalls = [];
                if (usePattern === "fadeIn") {
                    animCalls = SKILL_RECIPES.staggerFadeIn(animComp, allAnimNames, 0, intent.staggerAmount, 0.5);
                } else {
                    // slideUp for each text layer with stagger
                    for (var tli = 0; tli < scan.textLayers.length; tli++) {
                        var tlInfo = scan.textLayers[tli];
                        var posX = 960, posY = tli === 0 ? 400 : (tli === 1 ? 520 : 640);
                        var slideRecipe = SKILL_RECIPES.slideUpReveal(animComp, tlInfo.name, posX, posY, staggerT, 0.6);
                        for (var sr = 0; sr < slideRecipe.length; sr++) animCalls.push(slideRecipe[sr]);
                        staggerT += intent.staggerAmount;
                    }
                }
                if (animCalls.length > 0) {
                    for (var ac = 0; ac < animCalls.length; ac++) augTail.push(animCalls[ac]);
                    notes.push("Animation: added " + usePattern + " entrance for " + scan.textLayers.length + " text layer(s).");
                }
            }
        }

        // ── Assemble final call list: head injections + original + tail injections ──
        var finalOut = [];
        for (var ah = 0; ah < augHead.length; ah++) finalOut.push(augHead[ah]);
        for (var or2 = 0; or2 < out.length; or2++) finalOut.push(out[or2]);
        for (var at = 0; at < augTail.length; at++) finalOut.push(augTail[at]);

        return { calls: finalOut, notes: notes };
    }

    // ── SKILL CONTEXT (prompt injection) ──────────────────────────
    // Now that skills DO real things in the plan augmenter, the prompt
    // injection is for guidance only — it tells the model what to aim for
    // so its plan is closer to correct BEFORE we fix it.
    function buildSkillContext(skills, isFatherMode) {
        if (!skills || skills.length === 0) return "";

        var sd = false, st = false, sa = false, sc2 = false, sco = false, se = false, s3d = false;
        for (var i = 0; i < skills.length; i++) {
            var sk = skills[i];
            if (sk === "motionGraphics" || sk === "visualDesign" || sk === "designPrinciples") sd = true;
            if (sk === "typography") st = true;
            if (sk === "animation12" || sk === "motionGraphics") sa = true;
            if (sk === "colorTheory") sc2 = true;
            if (sk === "compositing") sco = true;
            if (sk === "expressionsSkill") se = true;
            if (sk === "spatial3D") s3d = true;
        }

        if (!isFatherMode) {
            // Lean mode: compact rules. The plan augmenter enforces the values; this guides intent.
            var lines = ["SKILL GUIDANCE — aim for these in your tool calls:"];
            if (sd) lines.push("DESIGN: createSolidLayer BG first (color ~[0.05,0.05,0.05]). Layer order: BG > shapes > text > adjustment.");
            if (st) lines.push("TYPOGRAPHY: hero fontSize≥96 Montserrat-Bold center near-white. subtitle fontSize=52 Montserrat center gray. body fontSize=28.\nExample: { tool:\"createTextLayer\", args:{text:\"TITLE\",fontSize:96,fontName:\"Montserrat-Bold\",bold:true,alignment:\"center\",color:[0.96,0.96,0.95,1],position:[960,400]} }");
            if (sa) lines.push("ANIMATION: after each addKeyframe, call setKeyframeInterpolation on that property.\nExample: addKeyframe opacity 0→100 at t=0→0.5, then setKeyframeInterpolation property=\"opacity\" allKeys=true inType=\"easeIn\" outType=\"easeOut\".");
            if (sc2) lines.push("COLOR: 60-30-10 — bg [0.05,0.05,0.05], panels [0.13,0.13,0.13], one accent color max.");
            if (sco) lines.push("COMPOSITING: addAdjustmentLayer at top + applyEffect ADBE Lumetri. BG > shapes > text > adjustment layer order.");
            if (se)  lines.push("EXPRESSIONS: wiggle(freq, amp) for organic feel. loopOut('cycle') for loops. thisComp.layer('name') for linking.");
            if (s3d) lines.push("3D: setLayerProperty threeDLayer=true before adding camera. Use z-depth for parallax: bg z=1500, mid z=800, fg z=200.");
            return "\nSKILL GUIDANCE:\n" + lines.slice(1).join("\n") + "\n";
        }

        // ── FATHER'S MONEY MODE: full design system ────────────────
        var b = ["\n\u2501\u2501 FATHER'S MONEY MODE — FULL SKILL CONTRACT \u2501\u2501\n"];

        if (sd || st || sc2) {
            b.push(
                "DESIGN SYSTEM\n" +
                "LAYER BUILD ORDER (mandatory):\n" +
                "  1. createSolidLayer — BG, color=[0.05,0.05,0.05]\n" +
                "  2. createShapeLayer — accent bars, dividers, frames\n" +
                "  3. createTextLayer  — body first, then subtitle, then hero (layer order)\n" +
                "  4. createNullLayer  — control layers\n" +
                "  5. addAdjustmentLayer — color grade, always last (on top)\n\n" +
                "C.R.A.P. (enforce all four):\n" +
                "  Contrast:   Important ≠ unimportant. Never low-contrast text on bg.\n" +
                "  Repetition: Same role = same font/size/color. No random variation.\n" +
                "  Alignment:  Everything on a grid. Nothing floating randomly.\n" +
                "  Proximity:  Related items close. Unrelated far.\n\n" +
                "TYPOGRAPHY HIERARCHY:\n" +
                "  Hero:     fontSize=96-144  fontName='Montserrat-Bold' bold=true alignment='center'\n" +
                "            color=[0.96,0.96,0.95,1]  position=[960,400]\n" +
                "  Subtitle: fontSize=48-64   fontName='Montserrat'      alignment='center'\n" +
                "            color=[0.72,0.72,0.70,1]  position=[960,520]\n" +
                "  Body:     fontSize=24-36   fontName='Montserrat'      alignment='left'\n" +
                "            color=[0.55,0.55,0.53,1]\n" +
                "  Label:    fontSize=18-24   tracking=200+  uppercase text\n\n" +
                "COLOR PALETTE (60-30-10):\n" +
                "  Background 60%: [0.05,0.05,0.05]\n" +
                "  Structure  30%: [0.13,0.13,0.13] — panels, cards, dividers\n" +
                "  Accent     10%: ONE of: orange[0.95,0.38,0.18]  cyan[0.18,0.82,0.95]\n" +
                "                          gold[0.95,0.78,0.18]  magenta[0.85,0.18,0.65]\n" +
                "  Text tiers:     [0.96,0.96,0.95] > [0.72,0.72,0.70] > [0.50,0.50,0.48]\n" +
                "  NEVER pure [0,0,0] or [1,1,1]. NEVER more than one accent color."
            );
        }

        if (sa) {
            b.push(
                "ANIMATION (12 Principles)\n" +
                "TIMING at 30fps:\n" +
                "  Snappy entrance: 12-18fr  |  Standard: 20-30fr (easeOut)  |  Cinematic: 40-60fr\n" +
                "  Stagger between elements: 5-8fr (0.17-0.27s)\n\n" +
                "ENTRANCE PATTERN (required for every text/shape layer):\n" +
                "  { tool:\"addKeyframe\",           args:{layerName:\"X\", property:\"opacity\",  time:T,      value:0   } }\n" +
                "  { tool:\"addKeyframe\",           args:{layerName:\"X\", property:\"opacity\",  time:T+0.67, value:100 } }\n" +
                "  { tool:\"addKeyframe\",           args:{layerName:\"X\", property:\"position\", time:T,      value:[x,y+40] } }\n" +
                "  { tool:\"addKeyframe\",           args:{layerName:\"X\", property:\"position\", time:T+0.5,  value:[x,y]   } }\n" +
                "  { tool:\"setKeyframeInterpolation\", args:{layerName:\"X\", property:\"opacity\",  allKeys:true, inType:\"easeIn\", outType:\"easeOut\"} }\n" +
                "  { tool:\"setKeyframeInterpolation\", args:{layerName:\"X\", property:\"position\", allKeys:true, inType:\"easeIn\", outType:\"easeOut\"} }\n" +
                "  Next element T += 0.17s\n\n" +
                "ACCENT BAR REVEAL:\n" +
                "  createShapeLayer  name='AccentBar'  size=[280,3]  fillColor=[accent]\n" +
                "  addKeyframe scale time=0 value=[0,100] → addKeyframe scale time=0.5 value=[100,100]\n" +
                "  setKeyframeInterpolation scale allKeys=true easeIn/easeOut\n\n" +
                "RULE: NEVER leave keyframes linear. ALWAYS call setKeyframeInterpolation."
            );
        }

        if (sco) {
            b.push(
                "COMPOSITING\n" +
                "GRADE STACK (addAdjustmentLayer always on top):\n" +
                "  applyEffect effectName='ADBE Lumetri'        ← master grade\n" +
                "  applyEffect effectName='ADBE HUE SATURATION' ← saturation\n\n" +
                "VIGNETTE:\n" +
                "  createShapeLayer name='Vignette' shapeType='ellipse' size=[2400,2400]\n" +
                "  fillColor=[0,0,0], opacity=60, blendMode=multiply\n\n" +
                "LAYER ORDER: BG Solid → Shapes → Text → Nulls → Adjustment on top"
            );
        }

        if (se) {
            b.push(
                "EXPRESSIONS\n" +
                "  Wiggle:     wiggle(3, 8)                                     ← subtle constant movement\n" +
                "  Link:       thisComp.layer('ControllerNull').effect('Slider Control')('Slider')\n" +
                "  Loop:       loopOut('cycle')                                  ← on keyframed properties\n" +
                "  Typewriter: text.sourceText  (set via time-indexed string)\n" +
                "SAFETY: always verify layer names match exactly. Typos silently break expressions."
            );
        }

        if (s3d) {
            b.push(
                "3D / CAMERA\n" +
                "  1. setLayerProperty threeDLayer=true  (ALL layers before adding camera)\n" +
                "  2. createCameraLayer type='TwoNode'   (good for reveals, products)\n" +
                "     createCameraLayer type='OneNode'   (fly-throughs, orbit)\n" +
                "PARALLAX DEPTH:\n" +
                "  Background: z=1500  |  Midground: z=800  |  Foreground: z=200  |  Camera start: z=2000\n" +
                "PUSH IN:\n" +
                "  addKeyframe position time=0 value=[960,540,2000] → time=5 value=[960,540,800]\n" +
                "  setKeyframeInterpolation easeIn/easeOut\n" +
                "AVOID: simultaneous XYZ rotation — gimbal lock. Prefer position + POI animation."
            );
        }

        b.push(
            "EXECUTION CHECKLIST:\n" +
            "  [ ] BG solid first, color=[0.05,0.05,0.05]\n" +
            "  [ ] Typography hierarchy enforced: 96+ / 52 / 28pt, always Montserrat\n" +
            "  [ ] Every addKeyframe followed by setKeyframeInterpolation\n" +
            "  [ ] Accent color on max 1-2 elements only\n" +
            "  [ ] Layer order: BG → shapes → text → nulls → adjustment on top\n" +
            (s3d ? "  [ ] threeDLayer=true on all layers before camera\n" : "") +
            "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"
        );

        return b.join("\n\n");
    }

    // ── COMPLIANCE EVALUATION ───────────────────────────────────────
    function agentEvaluateSkillCompliance(analysisResult, stepRecords) {
        var result = { score: 100, checks: [], failures: [] };
        if (!analysisResult || !analysisResult.skills || analysisResult.skills.length === 0) return result;

        var recs = stepRecords || [];
        var stats = { createLayer:0, createText:0, labeled:0, keyed:0, interped:0,
            expr:0, bridgeExpr:0, textWithFont:0, textWithSize:0, bgPresent:0 };

        for (var i = 0; i < recs.length; i++) {
            var r = recs[i];
            if (!r || r.ok !== true) continue;
            var t = canonicalizeAgentToolName(r.tool || "");
            var a = r.args || {};
            if (t === "createSolidLayer" || t === "createTextLayer" || t === "createShapeLayer" ||
                t === "createNullLayer" || t === "createCameraLayer" || t === "createLightLayer" ||
                t === "addAdjustmentLayer" || t === "duplicateLayer") stats.createLayer++;
            if (t === "createSolidLayer" && a.color) {
                var c = a.color; if (c[0] < 0.12 && c[1] < 0.12 && c[2] < 0.12) stats.bgPresent++;
            }
            if (t === "createTextLayer") {
                stats.createText++;
                if (a.fontName && a.fontName !== "") stats.textWithFont++;
                if (a.fontSize !== undefined) stats.textWithSize++;
            }
            if (t === "setLayerLabel") stats.labeled++;
            if (t === "addKeyframe") stats.keyed++;
            if (t === "setKeyframeInterpolation") stats.interped++;
            if (t === "applyExpression" || t === "applyLibraryExpression") stats.expr++;
            if (t === "generateExpressionFromPrompt") stats.bridgeExpr++;
        }

        function addCheck(name, pass, msg, critical) {
            result.checks.push({ name: name, pass: pass, message: msg, critical: !!critical });
            if (!pass) result.failures.push((critical ? "[critical] " : "") + name + ": " + msg);
        }

        if (hasSkill(analysisResult, "typography") && stats.createText > 0) {
            addCheck("Font enforcement", stats.textWithFont >= stats.createText,
                stats.textWithFont + "/" + stats.createText + " text layers have explicit font.", true);
            addCheck("Size enforcement", stats.textWithSize >= stats.createText,
                stats.textWithSize + "/" + stats.createText + " text layers have explicit size.", true);
        }
        if ((hasSkill(analysisResult, "visualDesign") || hasSkill(analysisResult, "designPrinciples") || hasSkill(analysisResult, "motionGraphics")) && stats.createLayer > 1) {
            addCheck("Layer organization", stats.labeled > 0,
                "Labeled " + stats.labeled + "/" + stats.createLayer + " layers.", false);
        }
        if (hasSkill(analysisResult, "motionGraphics") && stats.createLayer > 0 && stats.bgPresent === 0) {
            addCheck("Dark background", false, "No dark background solid found.", false);
        }
        if (hasSkill(analysisResult, "animation12") && stats.keyed > 0) {
            addCheck("Keyframe easing", stats.interped > 0,
                "Interpolation on " + stats.interped + "/" + stats.keyed + " keyframed properties.", true);
        }
        if (hasSkill(analysisResult, "expressionsSkill")) {
            addCheck("Expression usage", (stats.expr + stats.bridgeExpr) > 0,
                "Expression task with no expressions found.", false);
        }

        if (result.checks.length > 0) {
            var passed = 0;
            for (var ci = 0; ci < result.checks.length; ci++) if (result.checks[ci].pass) passed++;
            result.score = Math.round((passed / result.checks.length) * 100);
        }
        return result;
    }



    function agentComputeRunQuality(runSummary, repairSummary, skillEval) {
        var main = runSummary || { successCount: 0, failCount: 0, verificationFailCount: 0, recoveredCount: 0 };
        var rep = repairSummary || { successCount: 0, failCount: 0, verificationFailCount: 0, recoveredCount: 0 };
        var totalSuccess = (main.successCount || 0) + (rep.successCount || 0);
        var totalFail = (main.failCount || 0) + (rep.failCount || 0);
        var totalSteps = Math.max(1, totalSuccess + totalFail);
        var successScore = Math.round((totalSuccess / totalSteps) * 60);
        var verifyPenalty = Math.min(20, ((main.verificationFailCount || 0) + (rep.verificationFailCount || 0)) * 2);
        var recoveryBonus = Math.min(12, ((main.recoveredCount || 0) + (rep.recoveredCount || 0)) * 2);
        var skillScore = Math.round(((skillEval && skillEval.score !== undefined) ? skillEval.score : 100) * 0.28);
        var score = successScore + skillScore + recoveryBonus - verifyPenalty;
        if (score < 0) score = 0;
        if (score > 100) score = 100;
        return score;
    }




    // Hard Mode system prompt — compact tool reference, higher ceiling, executeExtendScript priority
    function buildAgentSystemPromptHardMode(userRequest, skillContext) {
        // NOTE: Do NOT pre-escape userRequest. JSON.stringify in buildPayload handles all escaping.
        var sc = skillContext || "";

        return [
            "You are Balongra Agent HARD MODE.",
            "Activated for complex, multi-step After Effects work. Build the COMPLETE thing.",
            "",
            "\u2501\u2501 RESPONSE FORMAT \u2501\u2501",
            "{ \"plan\": \"One sentence.\", \"tool_calls\": [ { \"tool\": \"name\", \"args\": {...} } ] }",
            "Start {, end }. Nothing else. Double quotes. No trailing commas.",
            "",
            "\u2501\u2501 SKILL ENFORCEMENT \u2501\u2501",
            "If Typography/Design/Animation skills are active, include concrete calls that reflect them",
            "(text hierarchy, interpolation polish, spacing/alignment consistency, and label organization).",
            "Do not output a generic mechanical layout when design skills are present.",
            "",
            "\u2501\u2501 HARD MODE RULES \u2501\u2501",
            "1. Up to 120 tool calls when needed. Do NOT be conservative. Implement everything asked.",
            "2. executeExtendScript is your power tool. Use it for: batch ops, niche effects, track mattes,",
            "   preserve-transparency, source swaps, complex expression linking, render queue ops.",
            "3. Call getCompInfo FIRST when user says 'current comp' or 'active comp'.",
            "4. setKeyframeInterpolation ALWAYS after all keyframes are placed.",
            "5. setLayerLabel on every layer — organize by type (blue=text, red=bg, purple=null).",
            "6. Bridge-first efficiency: for custom animation logic, prefer generateExpressionFromPrompt/applyLibraryExpression",
            "   before hand-writing long applyExpression code. For multi-step automation, prefer generateScriptFromPrompt",
            "   or runLibraryScript before excessive low-level micro-calls.",
            "7. If a step is likely to fail, inspect with getCompInfo and produce corrective calls, not generic retries.",
            "8. Order: comp > layers > properties > effects > expressions > keyframes > interpolation > shapes > parenting > precompose",
            "",
            "",
            "\u2501\u2501 CRITICAL AE CONSTRAINTS \u2501\u2501",
            "A. NEVER call setLayerProperties for position/scale/rotation/opacity on a layer that will",
            "   be animated. Use addKeyframe exclusively for animated properties.",
            "   setLayerProperties is for static-only: inPoint, outPoint, blendMode, motionBlur, is3DLayer.",
            "B. setLayerParent requires exact childLayerName AND parentLayerName. Never send null or a",
            "   guessed name. Check comp snapshot for exact names first.",
            "C. Do NOT call generateScriptFromPrompt as a default first step. Only call it when the user",
            "   explicitly asked for a reusable script. For execution use direct tool calls.",
            "D. alignLayersInComp and distributeLayersEvenly MUST run BEFORE addKeyframe on those layers.",
            "   Once position has keyframes, these tools cannot reposition layers safely.",
            "E. groupLayersUnderNull is the preferred way to parent layers under a null.",
            "   Use it instead of createNullLayer + multiple setLayerParent calls.",
            "F. NEVER use deleteLayer unless the user explicitly said to delete something.",
            "   If a layer has the wrong name, use renameLayer. If it has wrong properties, use setLayerProperties.",
            "   Do NOT delete and recreate — fix in place. Deleting wipes the user's existing work.",
            "G. PRESERVE EXISTING WORK. The comp snapshot shows what already exists. Build ON TOP of it.",
            "   Only touch what the user asked about. Leave everything else untouched.",
            "\u2501\u2501 56 TOOLS (compact ref) \u2501\u2501",
            "COMP: createComposition, setCompSettings, setCompRenderer, getCompInfo, createFolderInProject",
            "CREATE: createSolidLayer, createTextLayer, createShapeLayer, createNullLayer,",
            "        createCameraLayer, createLightLayer, addAdjustmentLayer",
            "MANAGE: setLayerProperties(position,scale,rotation,opacity,anchorPoint,inPoint,outPoint,",
            "          is3DLayer,motionBlur,blendMode), setLayerLabel, setLayerEnabled, setLayerSolo,",
            "        setLayerLocked, setLayerStretch, reorderLayer, trimLayer, splitLayer,",
            "        duplicateLayer, deleteLayer, renameLayer, setLayerParent,",
            "        groupLayersUnderNull, precomposeLayer",
            "ALIGN: alignLayersInComp(left|right|top|bottom|hcenter|vcenter|compCenter),",
            "       distributeLayersEvenly(axis:x|y), setAnchorAndPosition, scaleLayerRelative",
            "ANIM: addKeyframe(property,time,value,easeIn,easeOut),",
            "      setKeyframeInterpolation(linear|bezier|hold|easeIn|easeOut|auto),",
            "      setCurrentTime, setTimeRemapEnabled, setMotionBlur",
            "FX: applyEffect(layerName|layerNames|useSelectedLayers,effectMatchName,properties[{index,value}]),",
            "    removeEffect, setEffectProperty, addEffectKeyframe, applyExpressionToEffect",
            "    Targeting: layerName exact, layerNames array, or layerName='selected'/useSelectedLayers:true.",
            "    IMPORTANT: Never send ADBE Text* matchNames to applyEffect. Use addTextAnimator for text animators.",
            "EXPR: applyExpression(property,expression), removeExpression",
            "BRIDGE: applyLibraryExpression, runLibraryScript, generateExpressionFromPrompt, generateScriptFromPrompt",
            "PANEL: generatePanelFromPrompt(prompt, panelName) — generate a dockable ScriptUI panel.",
            "       Use when user asks for 'a panel', 'plugin', 'UI', 'controls', 'sliders', 'a tool with buttons'.",
            "       Opens immediately AND saves .jsx for docking. Great for wiggle controls, keyframe tools, etc.",
            "SHAPE: addTrimPaths, addTrimPathsKeyframe, addGradientFill,",
            "       addStrokeToShape, addShapeRepeater, addShapePathKeyframe",
            "       addGradientFill → SHAPE LAYERS ONLY (vector fill). For any other layer type,",
            "       use applyEffect with 'ADBE Ramp' instead.",
            "TEXT: updateTextContent, addTextAnimator",
            "MISC: addMarker",
            "GOD: executeExtendScript(script) — ES3 ONLY. No let/const/=>/forEach/map/filter.",
            "     var only. Access: app, app.project, app.project.activeItem, full AE DOM.",
            "     Blocked: system.callSystem, File(), Folder(), .execute(), app.quit",
            "",
            "\u2501\u2501 GRADIENT ROUTING RULE \u2501\u2501",
            "User says 'add a gradient' / 'gradient fill' / 'gradient background' / 'gradient overlay':",
            "  → Target is a Shape layer?  Use addGradientFill (vector fill, colors via startColor/endColor)",
            "  → Target is ANY other type? Use applyEffect with effectMatchName:'ADBE Ramp'",
            "    properties: [{index:2,value:[R,G,B,1]},{index:4,value:[R,G,B,1]}]  (index 2=StartColor, 4=EndColor)",
            "    StartPoint (index 1) default [960,0], EndPoint (index 3) default [960,1080]",
            "  When layer type is unknown or no layer is specified, prefer applyEffect+ADBE Ramp (safer).",
            "",
            "\u2501\u2501 ARG RULES \u2501\u2501",
            "Colors: [R,G,B] or [R,G,B,A] 0-1. White=[1,1,1]. Black=[0,0,0].",
            "Position: [X,Y] pixels from top-left. 1920x1080 center=[960,540].",
            "Scale: percent [X,Y]. Opacity: 0-100. compName: null=active comp.",
            "Layer targeting: use layerName for one layer, layerNames for many, or selected layers via layerName='selected'.",
            "",
            "\u2501\u2501 EFFECT MATCHNAMES \u2501\u2501",
            "Gaussian Blur: ADBE Gaussian Blur 2 (1=Blurriness)",
            "Fast Box Blur: ADBE Fast Blur 2 (1=Blurriness)",
            "Directional Blur: ADBE Motion Blur (1=Direction,2=Length)",
            "Drop Shadow: ADBE Drop Shadow (1=Color,2=Opacity,3=Dir,4=Dist,5=Softness)",
            "Glow: ADBE Glo2 (1=Threshold,2=Radius,3=Intensity)",
            "Hue/Sat: ADBE HUE SATURATION (1=Hue,2=Saturation,3=Lightness)",
            "Brightness/Contrast: ADBE Brightness & Contrast 2 (1=Brightness,2=Contrast)",
            "Levels: ADBE Levels2. Curves: ADBE CurvesCustom. Lumetri: ADBE Lumetri Color",
            "Gradient Ramp: ADBE Ramp (1=StartPt,2=StartColor,3=EndPt,4=EndColor)",
            "4-Color Gradient: ADBE 4-Color Gradient (1=P1,2=C1,3=P2,4=C2,5=P3,6=C3,7=P4,8=C4)",
            "Fill: ADBE Fill (4=Color). Tint: ADBE Tint (1=MapBlack,2=MapWhite,3=Amount)",
            "Tritone: ADBE Tritone (1=Highlights,2=Midtones,3=Shadows)",
            "Lens Flare: ADBE Lens Flare (1=FlareCenter,2=Brightness,3=LensType)",
            "Fractal Noise: ADBE Fractal Noise (4=Contrast,5=Brightness,7=Scale)",
            "Turbulent Displace: ADBE Turbulent Displace (2=Amount,3=Size)",
            "Mosaic: ADBE Mosaic (1=HBlocks,2=VBlocks). Sharpen: ADBE Sharpen (1=Amount)",
            "Linear Wipe: ADBE Linear Wipe (1=Completion,2=Angle)",
            "Transform: ADBE Geometry2 (1=Anchor,2=Position,3=Scale,4=Skew,5=Rotation)",
            "Slider Control: ADBE Slider Control (1=Slider)",
            "Noise: ADBE Noise (1=Amount). Invert: ADBE Invert. Posterize: ADBE Posterize (1=Level)",
            "",
            "\u2501\u2501 USER REQUEST \u2501\u2501",
            "",
            sc ? (sc + "\n") : "",
            userRequest,
            "",
            "Build the complete implementation. Output only the JSON object."
        ].join("\n");
    }

    // ============================================================
    // AGENT SYSTEM PROMPT BUILDER
    // ============================================================
    function buildAgentSystemPrompt(userRequest, skillContext) {
        var skillSection = skillContext || "";
        // NOTE: Do NOT pre-escape userRequest. JSON.stringify in buildPayload handles all escaping.

        var prompt = [
            "You are Balongra Agent, an expert After Effects automation engine.",
            "You receive a plain-English description of what to create in After Effects,",
            "and respond with a structured JSON plan that the host will execute natively.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 1 — RESPONSE FORMAT (ABSOLUTE)",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "Your entire response must be exactly one JSON object:",
            "{",
            "  \"plan\": \"One sentence describing what you will build.\",",
            "  \"tool_calls\": [",
            "    { \"tool\": \"toolName\", \"args\": { ... } },",
            "    { \"tool\": \"toolName\", \"args\": { ... } }",
            "  ]",
            "}",
            "",
            "Rules:",
            "- Start with { and end with }. Nothing before or after.",
            "- No markdown fences, no explanations outside the JSON.",
            "- All strings use double quotes. No trailing commas.",
            "- tool_calls is always an array, even for a single action.",
            "- If the user's comp already exists, omit createComposition.",
            "- When compName is null or omitted, the active comp is used.",
            "- If design/typography/animation skills are active, include polish-focused calls (not only raw structure).",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 2 — AVAILABLE TOOLS (56 total)",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "━━ COMPOSITION ━━",
            "createComposition",
            "  name, width, height, duration (sec), frameRate, bgColor ([R,G,B] 0-1)",
            "",
            "setCompSettings",
            "  compName, duration, frameRate, bgColor, workAreaStart, workAreaDuration",
            "",
            "setCompRenderer",
            "  compName, renderer (\"advanced_3d\"|\"cinema4d\"|\"classic_3d\")",
            "",
            "getCompInfo",
            "  compName — logs comp size, fps, duration, and all layer names to the log.",
            "  Use this to inspect the active comp before planning complex operations.",
            "",
            "createFolderInProject",
            "  folderName — creates an organizational folder in the Project panel.",
            "",
            "━━ LAYER CREATION ━━",
            "createSolidLayer",
            "  compName, name, color ([R,G,B] 0-1), width (optional), height (optional)",
            "",
            "createTextLayer",
            "  compName, name, text, fontSize, fontName (optional), color ([R,G,B] 0-1),",
            "  position ([X,Y]), alignment (\"left\"|\"center\"|\"right\"), bold, italic",
            "",
            "createShapeLayer",
            "  compName, name, shapeType (\"rectangle\"|\"ellipse\"|\"polygon\"|\"star\"),",
            "  size ([W,H]), position ([X,Y]), fillColor ([R,G,B,A] 0-1),",
            "  strokeColor ([R,G,B,A] 0-1), strokeWidth, cornerRadius (rect only),",
            "  points (polygon/star only)",
            "",
            "createNullLayer",
            "  compName, name, position ([X,Y])",
            "",
            "addAdjustmentLayer",
            "  compName, name, inPoint (sec, optional), outPoint (sec, optional)",
            "  Creates a full-comp adjustment layer for global effect stacking.",
            "",
            "createCameraLayer",
            "  compName, name, type (\"one-node\"|\"two-node\"), fov (degrees), position ([X,Y,Z])",
            "",
            "createLightLayer",
            "  compName, name, lightType (\"parallel\"|\"spot\"|\"point\"|\"ambient\"),",
            "  color ([R,G,B] 0-1), intensity (0-100)",
            "",
            "━━ LAYER MANAGEMENT ━━",
            "setLayerProperties",
            "  compName, layerName, position ([X,Y]), scale ([X,Y]%),",
            "  rotation (deg), opacity (0-100), anchorPoint ([X,Y]),",
            "  inPoint (sec), outPoint (sec), is3DLayer (bool), motionBlur (bool),",
            "  blendMode (\"normal\"|\"add\"|\"multiply\"|\"screen\"|\"overlay\"|\"darken\"|",
            "  \"lighten\"|\"colorDodge\"|\"colorBurn\"|\"hardLight\"|\"softLight\"|",
            "  \"difference\"|\"exclusion\"|\"hue\"|\"saturation\"|\"color\"|\"luminosity\")",
            "",
            "setLayerLabel",
            "  compName, layerName, label (\"red\"|\"yellow\"|\"aqua\"|\"pink\"|\"lavender\"|",
            "  \"peach\"|\"seafoam\"|\"blue\"|\"green\"|\"purple\"|\"orange\"|\"cyan\"|\"none\")",
            "",
            "setLayerEnabled",
            "  compName, layerName, enabled (bool) — toggles layer visibility (eye icon)",
            "",
            "setLayerSolo",
            "  compName, layerName, solo (bool)",
            "",
            "setLayerLocked",
            "  compName, layerName, locked (bool)",
            "",
            "setLayerStretch",
            "  compName, layerName, stretch (% — 200=2x slow, 50=2x fast)",
            "",
            "reorderLayer",
            "  compName, layerName, newIndex (1-based — 1=top of stack)",
            "",
            "trimLayer",
            "  compName, layerName, inPoint (sec), outPoint (sec), offset (startTime shift)",
            "",
            "splitLayer",
            "  compName, layerName, splitTime (sec) — splits into two layers at that time",
            "",
            "duplicateLayer",
            "  compName, layerName, newName",
            "",
            "deleteLayer",
            "  compName, layerName",
            "",
            "renameLayer",
            "  compName, layerName, newName",
            "",
            "setLayerParent",
            "  compName, childLayerName, parentLayerName (null = detach)",
            "",
            "groupLayersUnderNull",
            "  compName, layerNames ([string] array), nullName, position ([X,Y] optional)",
            "  Creates a null and parents all listed layers to it in one step.",
            "",
            "precomposeLayer",
            "  compName, layerNames ([string] array), newCompName, moveAllAttributes (bool)",
            "",
            "━━ ALIGNMENT & LAYOUT ━━",
            "alignLayersInComp",
            "  compName, layerNames ([string] array),",
            "  alignTo (\"left\"|\"right\"|\"top\"|\"bottom\"|\"hcenter\"|\"vcenter\"|\"compCenter\")",
            "",
            "distributeLayersEvenly",
            "  compName, layerNames ([string] array — min 2),",
            "  axis (\"x\"|\"y\"), margin (optional — fixed pixel gap between layers)",
            "",
            "setAnchorAndPosition",
            "  compName, layerName,",
            "  anchorPreset (\"topLeft\"|\"topCenter\"|\"topRight\"|\"centerLeft\"|\"center\"|",
            "  \"centerRight\"|\"bottomLeft\"|\"bottomCenter\"|\"bottomRight\")",
            "  Moves the anchor point without jumping the layer's visual position.",
            "",
            "scaleLayerRelative",
            "  compName, layerName, scaleMultiplier (e.g. 2.0 = double, 0.5 = half)",
            "",
            "━━ KEYFRAMES & ANIMATION ━━",
            "addKeyframe",
            "  compName, layerName,",
            "  property (\"position\"|\"scale\"|\"rotation\"|\"opacity\"|\"anchorPoint\"),",
            "  time (sec), value (matches property type),",
            "  easeIn ({ influence: 0-100, speed: float }), easeOut (same)",
            "",
            "setKeyframeInterpolation",
            "  compName, layerName, property, keyIndex (1-based),",
            "  inType (\"linear\"|\"bezier\"|\"hold\"|\"easeIn\"|\"easeOut\"|\"auto\"),",
            "  outType (same)",
            "",
            "setCurrentTime",
            "  compName, time (sec) — moves the CTI/playhead to the given time",
            "",
            "setTimeRemapEnabled",
            "  compName, layerName, enabled (bool) — enables time remapping on a layer",
            "",
            "setMotionBlur",
            "  compName, layerName (optional), motionBlur (bool),",
            "  compMotionBlurEnabled (bool, optional) — also toggle the comp switch",
            "",
            "━━ EFFECTS ━━",
            "applyEffect",
            "  compName, layerName, effectMatchName, effectDisplayName (optional),",
            "  properties (array of { index: int, value: any })",
            "  NEVER use applyEffect with ADBE Text* matchNames; text animator ops must use addTextAnimator.",
            "",
            "  EFFECT REFERENCE (matchName → property indices):",
            "    Gaussian Blur:        \"ADBE Gaussian Blur 2\"        1=Blurriness",
            "    Drop Shadow:          \"ADBE Drop Shadow\"            1=Color,2=Opacity,3=Direction,4=Distance,5=Softness",
            "    Glow:                 \"ADBE Glo2\"                   1=Threshold,2=Radius,3=Intensity",
            "    Hue/Saturation:       \"ADBE HUE SATURATION\"         1=Hue,2=Saturation,3=Lightness",
            "    Brightness/Contrast:  \"ADBE Brightness & Contrast 2\" 1=Brightness,2=Contrast",
            "    Tint:                 \"ADBE Tint\"                   1=MapBlack,2=MapWhite,3=Amount",
            "    Gradient Ramp:        \"ADBE Ramp\"                   1=StartPt,2=StartColor,3=EndPt,4=EndColor",
            "    Fill:                 \"ADBE Fill\"                   4=Color",
            "    Tritone:              \"ADBE Tritone\"                1=Highlights,2=Midtones,3=Shadows",
            "    Levels:               \"ADBE Levels2\"",
            "    Curves:               \"ADBE CurvesCustom\"",
            "    Fast Box Blur:        \"ADBE Fast Blur 2\"            1=Blurriness",
            "    Turbulent Displace:   \"ADBE Turbulent Displace\"     1=Displace,2=Amount,3=Size",
            "    Noise:                \"ADBE Noise\"                  1=Amount",
            "    Slider Control:       \"ADBE Slider Control\"         1=Slider",
            "    Checkbox Control:     \"ADBE Checkbox Control\"       1=Checkbox",
            "    Color Control:        \"ADBE Color Control\"          1=Color",
            "    Point Control:        \"ADBE Point Control\"          1=Point",
            "    Offset:               \"ADBE Shift Channels\"",
            "    Motion Tile:          \"ADBE Motion Tile\"            1=OutputWidth,2=OutputHeight",
            "    Echo:                 \"ADBE Echo\"                   1=EchoTime,2=NumEchoes",
            "    CC Sphere:            \"CC Sphere\"",
            "    Roughen Edges:        \"APC Roughen Edges\"",
            "    Transform:            \"ADBE Geometry2\"              1=Anchor,2=Position,3=Scale,4=Skew,5=Rotation",
            "    Stroke:               \"ADBE Stroke\"",
            "    Vegas:                \"ADBE Vegas\"",
            "    Radio Waves:          \"ADBE Radio Waves\"",
            "    Fractal Noise:        \"ADBE Fractal Noise\"          1=FractalType,2=NoiseType,4=Contrast,5=Brightness,7=Scale",
            "    Colorama:             \"ADBE Colorama\"",
            "    Cell Pattern:         \"ADBE Cell Pattern\"",
            "    Shatter:              \"ADBE Shatter\"",
            "    Card Dance:           \"ADBE Card Dance\"",
            "    Lumetri Color:        \"ADBE Lumetri Color\"",
            "    Vignette (Lumetri):   \"ADBE Lumetri Color\"  (Vignette is inside Lumetri, use Lumetri)",
            "    Linear Wipe:          \"ADBE Linear Wipe\"              1=Completion,2=Angle",
            "    Radial Wipe:          \"ADBE Radial Wipe\"              1=Completion,2=StartAngle",
            "    CC Light Sweep:       \"CC Light Sweep\"",
            "    Lens Flare:           \"ADBE Lens Flare\"               1=FlareCenter,2=Brightness,3=LensType",
            "    4-Color Gradient:     \"ADBE 4-Color Gradient\"         1=P1,2=C1,3=P2,4=C2,5=P3,6=C3,7=P4,8=C4",
            "    Sharpen:              \"ADBE Sharpen\"                  1=Amount",
            "    Unsharp Mask:         \"ADBE Unsharp Mask\"             1=Amount,2=Radius",
            "    Mosaic:               \"ADBE Mosaic\"                   1=HBlocks,2=VBlocks",
            "    Posterize:            \"ADBE Posterize\"                1=Level",
            "    Invert:               \"ADBE Invert\"",
            "    Channel Blur:         \"ADBE Channel Blur\"",
            "    CC Radial Fast Blur:  \"CC Radial Fast Blur\"           1=Amount",
            "    Directional Blur:     \"ADBE Motion Blur\"              1=Direction,2=Length",
            "    Glow (Old):           \"ADBE Glow\"",
            "    Venetian Blinds:      \"ADBE Venetian Blinds\"          1=Completion,2=Direction",
            "",
            "removeEffect",
            "  compName, layerName, effectMatchName",
            "",
            "setEffectProperty",
            "  compName, layerName, effectMatchName,",
            "  properties (array of { index: int, value: any })",
            "  Modifies properties on an already-applied effect without re-applying it.",
            "",
            "addEffectKeyframe",
            "  compName, layerName, effectMatchName, propertyIndex, time (sec), value",
            "  Animates an effect property over time.",
            "",
            "━━ EXPRESSIONS ━━",
            "applyExpression",
            "  compName, layerName,",
            "  property (\"position\"|\"scale\"|\"rotation\"|\"opacity\"|\"anchorPoint\"),",
            "  expression (string — valid AE ES3 expression code)",
            "",
            "removeExpression",
            "  compName, layerName, property — clears the expression on a property",
            "",
            "applyExpressionToEffect",
            "  compName, layerName, effectMatchName, propertyIndex, expression",
            "  Applies an expression directly to an effect slider or property.",
            "",
            "━━ TEXT ━━",
            "updateTextContent",
            "  compName, layerName, text, fontSize (optional), color (optional),",
            "  bold (optional), italic (optional), alignment (optional)",
            "  Updates the content/style of an existing text layer.",
            "",
            "addTextAnimator",
            "  compName, layerName,",
            "  animatorType (\"opacity\"|\"scale\"|\"position\"|\"rotation\"|\"tracking\"|\"fill_color\"),",
            "  rangeStart (0-100%), rangeEnd (0-100%), value",
            "  Adds a text animator with a range selector for per-character animation.",
            "",
            "━━ SHAPES (advanced) ━━",
            "addGradientFill",
            "  compName, layerName, groupName (optional),",
            "  startColor ([R,G,B,A] 0-1), endColor ([R,G,B,A] 0-1),",
            "  startPoint ([X,Y]), endPoint ([X,Y]), type (\"linear\"|\"radial\")",
            "  *** SHAPE LAYERS ONLY. For solid/text/footage/adjustment use applyEffect+'ADBE Ramp'. ***",
            "",
            "GRADIENT ROUTING — always follow this rule:",
            "  Shape layer target  → addGradientFill (vector fill inside shape group)",
            "  Any other layer     → applyEffect { effectMatchName:'ADBE Ramp',",
            "                          properties:[{index:1,value:[X,Y]},{index:2,value:[R,G,B,1]},",
            "                                      {index:3,value:[X,Y]},{index:4,value:[R,G,B,1]}] }",
            "  Unknown/mixed       → prefer applyEffect+ADBE Ramp (always safe)",
            "  Gradient background → createSolidLayer first, then applyEffect 'ADBE Ramp'",
            "",
            "addStrokeToShape",
            "  compName, layerName, groupName (optional),",
            "  color ([R,G,B,A] 0-1), width (pixels),",
            "  lineCap (\"butt\"|\"round\"|\"projecting\"),",
            "  dashLength (optional), dashGap (optional)",
            "",
            "addShapeRepeater",
            "  compName, layerName, groupName (optional),",
            "  copies (int), offset (float),",
            "  positionOffset ([X,Y]), rotationOffset (degrees),",
            "  scaleStart ([X,Y]%)",
            "  Creates a repeater modifier inside a shape group.",
            "",
            "addTrimPaths",
            "  compName, layerName, groupName (optional),",
            "  start (0-100%), end (0-100%), offset (degrees)",
            "  Adds a Trim Paths modifier — essential for stroke draw-on animations.",
            "",
            "addTrimPathsKeyframe",
            "  compName, layerName, groupName (optional),",
            "  property (\"start\"|\"end\"|\"offset\"), time (sec), value (0-100 or degrees)",
            "  Animates a Trim Paths property. Use addTrimPaths first.",
            "",
            "addShapePathKeyframe",
            "  compName, layerName, groupName (optional),",
            "  time (sec), points ([[x,y],...]), inTangents, outTangents, closed (bool)",
            "  Animates the vertices of a shape for morphing effects.",
            "",
            "━━ MARKERS ━━",
            "addMarker",
            "  compName, layerName (null = comp marker), time (sec),",
            "  comment (string), duration (sec, optional)",
            "",
            "━━ BRIDGE TOOLS (LIBRARY + GENERATORS) ━━",
            "applyLibraryExpression",
            "  expressionName, compName (optional), layerName|layerNames|useSelectedLayers, property (optional override)",
            "  Applies a saved expression from the Expressions panel library.",
            "",
            "runLibraryScript",
            "  scriptName",
            "  Runs a saved script from the Scripts panel library (safe operations only).",
            "",
            "generateExpressionFromPrompt",
            "  prompt, compName (optional), layerName|layerNames|useSelectedLayers (optional),",
            "  property/targetProperty (optional), applyNow (optional), saveToLibrary (optional)",
            "  Generates an expression using the AI expression generator and can apply it immediately.",
            "",
            "generateScriptFromPrompt",
            "  prompt, scriptName (optional), runNow (optional), saveToLibrary (optional)",
            "  Generates a script using the AI script generator and can run it immediately.",
            "",
            "━━ ESCAPE HATCH (God Tool) ━━",
            "executeExtendScript",
            "  script (string — raw ExtendScript code to execute in the AE context)",
            "",
            "  PURPOSE: This is your ultimate fallback. When NO combination of the",
            "  above tools can achieve the user's request, use this tool to run",
            "  arbitrary ExtendScript code directly inside After Effects.",
            "",
            "  ⚠ CRITICAL: ES3 ONLY — ZERO TOLERANCE ⚠",
            "  The script is validated before execution. ANY modern syntax = REJECTED.",
            "  WRONG: let x = 5;              RIGHT: var x = 5;",
            "  WRONG: const y = 10;            RIGHT: var y = 10;",
            "  WRONG: () => {}                 RIGHT: function() {}",
            "  WRONG: `hello ${name}`          RIGHT: 'hello ' + name",
            "  WRONG: arr.forEach(fn)          RIGHT: for (var i = 0; i < arr.length; i++) {}",
            "  WRONG: arr.map(fn)              RIGHT: manual for loop pushing to new array",
            "  WRONG: arr.includes(x)          RIGHT: manual indexOf check",
            "  WRONG: Object.keys(obj)         RIGHT: for (var k in obj) { if (obj.hasOwnProperty(k)) {} }",
            "  WRONG: var [a,b] = arr;         RIGHT: var a = arr[0]; var b = arr[1];",
            "",
            "  RULES:",
            "  1. ALWAYS prefer dedicated tools first. Never use executeExtendScript",
            "     for operations that a dedicated tool already handles.",
            "  2. File I/O, system commands, and app.quit are BLOCKED for safety.",
            "  3. You have access to app, app.project, app.project.activeItem, and",
            "     all AE DOM objects. Declare all variables with var.",
            "  4. The return value of the last expression is captured and reported.",
            "  5. End your script with a status string so the log shows what happened.",
            "",
            "  ━━ EXAMPLE 1: Apply a niche effect with properties ━━",
            "  { \"tool\": \"executeExtendScript\", \"args\": {",
            "      \"script\": \"var comp = app.project.activeItem; var layer = comp.layer('BG'); var fx = layer.Effects.addProperty('ADBE Venetian Blinds'); fx.property(1).setValue(50); fx.property(2).setValue(90); 'Venetian Blinds applied with width=50, angle=90.';\"",
            "  }}",
            "",
            "  ━━ EXAMPLE 2: Batch rename all layers with a prefix ━━",
            "  { \"tool\": \"executeExtendScript\", \"args\": {",
            "      \"script\": \"var comp = app.project.activeItem; var count = 0; for (var i = 1; i <= comp.numLayers; i++) { comp.layer(i).name = 'Scene_' + comp.layer(i).name; count++; } count + ' layers renamed.';\"",
            "  }}",
            "",
            "  ━━ EXAMPLE 3: Set track matte and preserve transparency ━━",
            "  { \"tool\": \"executeExtendScript\", \"args\": {",
            "      \"script\": \"var comp = app.project.activeItem; var layer = comp.layer('Footage'); layer.trackMatteType = TrackMatteType.ALPHA; layer.preserveTransparency = true; 'Track matte set to alpha, transparency preserved.';\"",
            "  }}",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 3 — ARGUMENT RULES",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "Colors are always [R, G, B] or [R, G, B, A] with values 0–1.",
            "  White = [1,1,1]   Black = [0,0,0]   Red = [1,0,0]",
            "  Fully transparent = A = 0  Fully opaque = A = 1",
            "",
            "Positions are pixel coordinates [X, Y] from top-left of comp.",
            "  Center of 1920x1080 = [960, 540]",
            "",
            "Scale is percent [X, Y]. 100% = [100, 100].",
            "Rotation is degrees (float). Clockwise is positive.",
            "Opacity is 0–100.",
            "",
            "compName: Use the exact name of the composition.",
            "  If the user says to use the active/current comp, omit compName or set it to null.",
            "  If you are creating a new comp in this same run, use that comp's name for all",
            "  subsequent tool calls that operate on it.",
            "",
            "layerName: Use the exact name assigned in the 'name' arg when the layer was created.",
            "  Names must be consistent across tool calls in the same plan.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "SECTION 4 — PLANNING STRATEGY",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            "CRITICAL AE CONSTRAINTS — VIOLATIONS WILL FAIL:",
            "  A. setLayerProperties is for STATIC properties only.",
            "     NEVER use it for position/scale/rotation/opacity if that property will have keyframes.",
            "     If you intend to animate a property -> use addKeyframe only, never setLayerProperties.",
            "  B. setLayerParent: childLayerName and parentLayerName must both be exact existing layer names.",
            "     Never send null or an assumed name. Use groupLayersUnderNull instead when grouping multiple layers.",
            "  C. alignLayersInComp and distributeLayersEvenly move layers via setValue.",
            "     Call them BEFORE animating position, or not at all. After addKeyframe on position they will fail.",
            "  D. Do NOT call generateScriptFromPrompt unless the user specifically asked for a reusable library script.",
            "     For building things, use direct tool calls.",
            "  E. NEVER use deleteLayer unless the user explicitly said to delete something.",
            "     Wrong layer name? Use renameLayer. Wrong property? Use setLayerProperties. Fix in place — never delete and recreate.",
            "  F. PRESERVE EXISTING WORK. The comp snapshot shows what is already in the comp.",
            "     Build ON TOP of existing layers. Do NOT remove or overwrite anything the user did not ask you to touch.",
            "",
            "ORDERING RULE — always follow this sequence:",
            "  1. createComposition (if needed)",
            "  2. Create layers (solid, text, shape, null, etc.)",
            "  3. setLayerProperties for STATIC properties only (inPoint/outPoint/blendMode/is3DLayer/motionBlur)",
            "     -> For anything you will animate: skip setLayerProperties, go straight to addKeyframe",
            "  4. alignLayersInComp / distributeLayersEvenly (MUST run before addKeyframe on position)",
            "  5. applyEffect / addAdjustmentLayer",
            "  6. applyExpression / applyExpressionToEffect",
            "  7. addKeyframe / addEffectKeyframe (time=0 first, then target time)",
            "  8. setKeyframeInterpolation (after ALL keyframes for a layer are placed)",
            "  9. addTrimPaths / addShapeRepeater / addGradientFill (shape modifiers last)",
            " 10. groupLayersUnderNull (preferred) or setLayerParent (parenting after creation)",
            " 11. precomposeLayer (always last, after everything is built)",
            "",
            "KEY PATTERNS:",
            "",
            "Draw-on stroke animation:",
            "  1. createShapeLayer with strokeWidth > 0",
            "  2. addTrimPaths with start=0, end=0",
            "  3. addTrimPathsKeyframe: property=end, time=0, value=0",
            "  4. addTrimPathsKeyframe: property=end, time=T, value=100",
            "  5. setKeyframeInterpolation: outType=easeOut on key 1, inType=easeIn on key 2",
            "",
            "Animated counter/text:",
            "  1. createTextLayer",
            "  2. applyEffect: ADBE Slider Control",
            "  3. addEffectKeyframe: from 0 to target value over duration",
            "  4. applyExpression: property=Source Text, expression links to slider",
            "",
            "Grouped UI elements:",
            "  1. Create all child layers",
            "  2. groupLayersUnderNull — parents everything to a single control null",
            "  3. Animate the null for synchronized movement",
            "",
            "Screen layout / card grid:",
            "  1. Create first card layer",
            "  2. duplicateLayer N times with new names",
            "  3. distributeLayersEvenly to space them out",
            "  4. alignLayersInComp to center the row",
            "",
            "Staggered reveal (index-offset):",
            "  1. Create layers and name them sequentially",
            "  2. addKeyframe on each layer's opacity/scale at progressively later times",
            "     (e.g. layer 1 at t=0, layer 2 at t=0.1, etc.)",
            "",
            "Bridge efficiency rules:",
            "  - If the request asks for a custom reusable expression rig, use generateExpressionFromPrompt",
            "    (set applyNow=true when layer targets are known; otherwise applyNow=false + saveToLibrary=true).",
            "  - If the request is a large procedural build, use generateScriptFromPrompt or runLibraryScript",
            "    instead of dozens of brittle micro-steps.",
            "",
            "Ease quality — always polish motion with setKeyframeInterpolation:",
            "  - All position/scale animations: outType=easeOut on first key, inType=easeIn on last",
            "  - Hold frames: outType=hold",
            "  - Instant snaps: inType=linear, outType=linear",
            "",
            "If the user says 'active comp' or 'current comp': use compName: null.",
            "If you are unsure what layers exist, use getCompInfo first.",
            "Write the 'plan' field in plain English, max 1 sentence.",
            "Do not add tool calls for things the user did not ask for.",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "USER REQUEST",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
            skillSection ? (skillSection + "\n") : "",
            userRequest,
            "",
            "Output only the JSON object. Nothing else."
        ].join("\n");

        return prompt;
    }

    function promoteModelTierForAnalysis(currentTier, analysisResult) {
        var tier = normalizeModelTier(currentTier);
        if (tier === "small") return "medium";
        if (tier === "medium") return "large";
        if (tier === "large" && analysisResult && (analysisResult.isGoldMode || analysisResult.isFathersMoneyMode)) return "max";
        return tier;
    }

    function summarizeFailedStepPatterns(failedSteps) {
        var fails = failedSteps || [];
        var counts = {
            missingLayer: 0,
            missingProperty: 0,
            missingArg: 0,
            easing: 0,
            expression: 0,
            verification: 0,
            skill: 0,
            unknownTool: 0,
            other: 0
        };

        for (var i = 0; i < fails.length; i++) {
            var low = String(fails[i] || "").toLowerCase();
            if (low.indexOf("unknown tool") !== -1) counts.unknownTool++;
            else if (low.indexOf("layer") !== -1 && low.indexOf("not found") !== -1) counts.missingLayer++;
            else if (low.indexOf("property") !== -1 && low.indexOf("not found") !== -1) counts.missingProperty++;
            else if (low.indexOf("required") !== -1 || low.indexOf("missing") !== -1) counts.missingArg++;
            else if (low.indexOf("settemporaleaseatkey") !== -1 || low.indexOf("interpolation") !== -1) counts.easing++;
            else if (low.indexOf("expression") !== -1) counts.expression++;
            else if (low.indexOf("post-check failed") !== -1 || low.indexOf("verification") !== -1) counts.verification++;
            else if (low.indexOf("skill check") !== -1) counts.skill++;
            else counts.other++;
        }

        return [
            "Failure pattern summary:",
            "- missing layer: " + counts.missingLayer,
            "- missing property: " + counts.missingProperty,
            "- missing argument: " + counts.missingArg,
            "- easing/interpolation issues: " + counts.easing,
            "- expression issues: " + counts.expression,
            "- verification issues: " + counts.verification,
            "- skill contract issues: " + counts.skill,
            "- unknown tool: " + counts.unknownTool,
            "- other: " + counts.other
        ].join("\n");
    }

    // ============================================================
    // MISSING CRITICAL FUNCTIONS — PHASE 1 FIX
    // ============================================================

    // Produce a stable string key from a tool args object (for deduplication/logging).
    function agentHashArgs(args) {
        try { return JSON.stringify(args || {}); } catch (e) { return String(args || ""); }
    }

    // Validate and normalise the raw JSON plan returned by the AI.
    // Applies skill augmentation and caps to the configured tool-call limit.
    // Returns { ok, plan, tool_calls, warnings }.
    function normalizeAgentPlan(agentPlan, analysisResult) {
        var warnings = [];

        if (!agentPlan || typeof agentPlan !== "object") {
            return { ok: false, warnings: ["Plan is null or non-object."] };
        }

        // Recover bare array responses
        if (agentPlan instanceof Array) {
            agentPlan = { plan: "Recovered plan from bare array.", tool_calls: agentPlan };
            warnings.push("Response was a bare array — wrapped automatically.");
        }

        if (!agentPlan.tool_calls || !(agentPlan.tool_calls instanceof Array)) {
            return { ok: false, warnings: warnings.concat(["No tool_calls array in plan."]) };
        }

        // Strip malformed entries
        var cleanCalls = [];
        for (var i = 0; i < agentPlan.tool_calls.length; i++) {
            var c = agentPlan.tool_calls[i];
            if (c && typeof c === "object" && (c.tool || c.name)) {
                cleanCalls.push(c);
            } else {
                warnings.push("Dropped malformed call at index " + i + ".");
            }
        }

        if (cleanCalls.length === 0) {
            return { ok: false, warnings: warnings.concat(["No valid calls after filtering."]) };
        }

        // Cap to the configured maximum
        var maxCalls = getAgentPlanMaxToolCalls(analysisResult);
        if (cleanCalls.length > maxCalls) {
            warnings.push("Plan had " + cleanCalls.length + " calls, capped to " + maxCalls + ".");
            cleanCalls = cleanCalls.slice(0, maxCalls);
        }

        // Apply skill-driven plan augmentation (adds easing, labels, BG, etc.)
        try {
            var augResult = applySkillActionsToPlanCalls(cleanCalls, analysisResult);
            // applySkillActionsToPlanCalls returns { calls: [...], notes: [...] }
            if (augResult && augResult.calls instanceof Array) {
                cleanCalls = augResult.calls;
                if (augResult.notes && augResult.notes.length > 0) {
                    for (var ni = 0; ni < augResult.notes.length; ni++) {
                        warnings.push("Skill: " + augResult.notes[ni]);
                    }
                }
            }
        } catch (augErr) {
            warnings.push("Skill augmentation error: " + augErr.toString());
        }

        return {
            ok: true,
            plan: agentPlan.plan || "Execute plan.",
            tool_calls: cleanCalls,
            warnings: warnings
        };
    }

    // Route a single { tool, args } call object to the correct agentTool_ function.
    // Returns { ok, msg } matching every tool's contract.
    function dispatchAgentTool(call, context) {
        var tool = String(call.tool || "");
        var args = call.args || {};

        // Resolve registry aliases to canonical names so the if-chain below is clean
        tool = canonicalizeAgentToolName(tool);

        if (tool === "createComposition")         return agentTool_createComposition(args, context);
        if (tool === "createSolidLayer")          return agentTool_createSolidLayer(args, context);
        if (tool === "createTextLayer")           return agentTool_createTextLayer(args, context);
        if (tool === "createShapeLayer")          return agentTool_createShapeLayer(args, context);
        if (tool === "createNullLayer")           return agentTool_createNullLayer(args, context);
        if (tool === "createCameraLayer")         return agentTool_createCameraLayer(args, context);
        if (tool === "createLightLayer")          return agentTool_createLightLayer(args, context);
        if (tool === "setLayerProperties")        return agentTool_setLayerProperties(args, context);
        if (tool === "addKeyframe")               return agentTool_addKeyframe(args, context);
        if (tool === "applyEffect")               return agentTool_applyEffect(args, context);
        if (tool === "applyExpression")           return agentTool_applyExpression(args, context);
        if (tool === "setLayerParent")            return agentTool_setLayerParent(args, context);
        if (tool === "duplicateLayer")            return agentTool_duplicateLayer(args, context);
        if (tool === "deleteLayer")               return agentTool_deleteLayer(args, context);
        if (tool === "renameLayer")               return agentTool_renameLayer(args, context);
        if (tool === "precomposeLayer")           return agentTool_precomposeLayer(args, context);
        if (tool === "addMarker")                 return agentTool_addMarker(args, context);
        if (tool === "setCompSettings")           return agentTool_setCompSettings(args, context);
        if (tool === "setKeyframeInterpolation")  return agentTool_setKeyframeInterpolation(args, context);
        if (tool === "removeEffect")              return agentTool_removeEffect(args, context);
        if (tool === "setEffectProperty")         return agentTool_setEffectProperty(args, context);
        if (tool === "addEffectKeyframe")         return agentTool_addEffectKeyframe(args, context);
        if (tool === "removeExpression")          return agentTool_removeExpression(args, context);
        if (tool === "setLayerLabel")             return agentTool_setLayerLabel(args, context);
        if (tool === "setLayerSolo")              return agentTool_setLayerSolo(args, context);
        if (tool === "setLayerEnabled")           return agentTool_setLayerEnabled(args, context);
        if (tool === "setLayerLocked")            return agentTool_setLayerLocked(args, context);
        if (tool === "reorderLayer")              return agentTool_reorderLayer(args, context);
        if (tool === "trimLayer")                 return agentTool_trimLayer(args, context);
        if (tool === "splitLayer")                return agentTool_splitLayer(args, context);
        if (tool === "setCurrentTime")            return agentTool_setCurrentTime(args, context);
        if (tool === "addAdjustmentLayer")        return agentTool_addAdjustmentLayer(args, context);
        if (tool === "addTextAnimator")           return agentTool_addTextAnimator(args, context);
        if (tool === "updateTextContent")         return agentTool_updateTextContent(args, context);
        if (tool === "setAnchorAndPosition")      return agentTool_setAnchorAndPosition(args, context);
        if (tool === "alignLayersInComp")         return agentTool_alignLayersInComp(args, context);
        if (tool === "distributeLayersEvenly")    return agentTool_distributeLayersEvenly(args, context);
        if (tool === "groupLayersUnderNull")      return agentTool_groupLayersUnderNull(args, context);
        if (tool === "addShapePathKeyframe")      return agentTool_addShapePathKeyframe(args, context);
        if (tool === "addGradientFill")           return agentTool_addGradientFill(args, context);
        if (tool === "addStrokeToShape")          return agentTool_addStrokeToShape(args, context);
        if (tool === "addShapeRepeater")          return agentTool_addShapeRepeater(args, context);
        if (tool === "addTrimPaths")              return agentTool_addTrimPaths(args, context);
        if (tool === "addTrimPathsKeyframe")      return agentTool_addTrimPathsKeyframe(args, context);
        if (tool === "setTimeRemapEnabled")       return agentTool_setTimeRemapEnabled(args, context);
        if (tool === "setMotionBlur")             return agentTool_setMotionBlur(args, context);
        if (tool === "createFolderInProject")     return agentTool_createFolderInProject(args, context);
        if (tool === "setLayerStretch")           return agentTool_setLayerStretch(args, context);
        if (tool === "applyExpressionToEffect")   return agentTool_applyExpressionToEffect(args, context);
        if (tool === "setCompRenderer")           return agentTool_setCompRenderer(args, context);
        if (tool === "scaleLayerRelative")        return agentTool_scaleLayerRelative(args, context);
        if (tool === "getCompInfo")               return agentTool_getCompInfo(args, context);
        if (tool === "executeExtendScript")       return agentTool_executeExtendScript(args, context);
        if (tool === "applyLibraryExpression" || tool === "applySavedExpression")
                                                  return agentTool_applyLibraryExpression(args, context);
        if (tool === "runSavedScript")            return agentTool_runLibraryScript(args, context);
        if (tool === "runLibraryScript")          return agentTool_runLibraryScript(args, context);
        if (tool === "generateExpressionFromPrompt" || tool === "generateExpression")
                                                  return agentTool_generateExpressionFromPrompt(args, context);
        if (tool === "generateScriptFromPrompt"  || tool === "generateScript")
                                                  return agentTool_generateScriptFromPrompt(args, context);
        if (tool === "generatePanelFromPrompt")   return agentTool_generatePanelFromPrompt(args, context);
        if (tool === "rigPropertyToController")   return agentTool_rigPropertyToController(args, context);
        if (tool === "separateDimensions")        return agentTool_separateDimensions(args, context);
        if (tool === "exposeToEssentialGraphics") return agentTool_exposeToEssentialGraphics(args, context);

        return { ok: false, msg: "Unknown tool: '" + tool + "'. Check tool name spelling." };
    }

    // Light post-execution check — verifies that creation tools actually produced their artefact.
    // Returns { ok, msg }. Failures here demote the step to a failed state.
    function agentVerifyToolOutcome(call, context) {
        var tool = call.tool || "";
        var args = call.args || {};
        try {
            if (tool === "createComposition") {
                var cName = args.name || args.compName || "";
                if (cName) {
                    for (var i = 1; i <= app.project.numItems; i++) {
                        if (app.project.item(i) instanceof CompItem && app.project.item(i).name === cName) {
                            return { ok: true, msg: "Comp '" + cName + "' confirmed." };
                        }
                    }
                    return { ok: false, msg: "Comp '" + cName + "' missing after createComposition." };
                }
            }
            if (tool === "createTextLayer" || tool === "createSolidLayer" ||
                tool === "createShapeLayer" || tool === "createNullLayer" ||
                tool === "createCameraLayer" || tool === "createLightLayer" ||
                tool === "addAdjustmentLayer") {
                var lName = args.name || args.layerName || "";
                var comp = agentFindComp(args.compName, context);
                if (comp && lName) {
                    for (var j = 1; j <= comp.numLayers; j++) {
                        if (comp.layer(j).name === lName) return { ok: true, msg: "Layer '" + lName + "' confirmed." };
                    }
                    return { ok: false, msg: "Layer '" + lName + "' missing after " + tool + "." };
                }
            }
        } catch (e) {
            // Never fail verification on an exception — the tool already reported success.
        }
        return { ok: true, msg: "ok" };
    }

    // Categorise an error message into a structured failure type used by recovery logic.
    function agentClassifyFailure(msg, call) {
        var low = String(msg || "").toLowerCase();
        if (low.indexOf("layer") !== -1 && low.indexOf("not found") !== -1)
            return { type: "missingLayer", recoverable: true };
        if (low.indexOf("property") !== -1 && low.indexOf("not found") !== -1)
            return { type: "missingProperty", recoverable: false };
        if (low.indexOf("interpolation") !== -1 || low.indexOf("easing") !== -1 ||
            low.indexOf("settemporalease") !== -1)
            return { type: "easing", recoverable: true };
        if (low.indexOf("required") !== -1 || low.indexOf("missing arg") !== -1 ||
            low.indexOf("missing field") !== -1)
            return { type: "missingArg", recoverable: false };
        if (low.indexOf("unknown tool") !== -1)
            return { type: "unknownTool", recoverable: false };
        if (low.indexOf("effect") !== -1 && low.indexOf("not found") !== -1)
            return { type: "missingEffect", recoverable: false };
        return { type: "other", recoverable: false };
    }

    // Build a short list of alternative tool calls to attempt after a failure.
    // Returns [] when no sensible recovery exists (most cases).
    function agentBuildRecoveryCalls(call, failure, context, analysis) {
        var tool = call.tool || "";
        var args = call.args || {};
        var recoveries = [];
        if (!failure || !failure.recoverable) return recoveries;

        // Layer-not-found: retry targeting the selected layer(s) instead
        if (failure.type === "missingLayer" && args.layerName && !args.useSelectedLayers) {
            var altArgs = agentCloneCallArgs(args);
            delete altArgs.layerName;
            altArgs.useSelectedLayers = true;
            recoveries.push({ tool: tool, args: altArgs, _recoveryReason: "layer not found → selected layers" });
        }

        // Easing failure: retry with allKeys and explicit bezier type
        if (failure.type === "easing" && tool === "setKeyframeInterpolation") {
            var eArgs = agentCloneCallArgs(args);
            eArgs.allKeys = true;
            eArgs.interpolationType = eArgs.interpolationType || "bezier";
            recoveries.push({ tool: tool, args: eArgs, _recoveryReason: "easing retry with allKeys=true" });
        }

        return recoveries;
    }

    // ============================================================
    // AGENT API CALLER
    // Shared internal function used by the Agent tab.
    // Returns the parsed { plan, tool_calls } object or null.
    // ============================================================
    // analysisResult (optional) — from analyzePrompt(). Enables Hard Mode and skill injection.
    function callAgentAPI(userRequest, model, apiKey, apiUrl, statusFn, analysisResult, options) {
        var opts = options || {};
        var isRepair = (opts.isRepair === true);
        var maxBatchCalls = parseInt(opts.maxBatchCalls, 10);
        if (isNaN(maxBatchCalls) || maxBatchCalls < 2) maxBatchCalls = 16;
        var maxRetries = 1;
        var attempts = 0;
        var isHard = !!(analysisResult && analysisResult.isHardMode);
        var isGold = !!(analysisResult && analysisResult.isGoldMode);
        var isFather = !!(analysisResult && analysisResult.isFathersMoneyMode);
        // Repair sessions use the same skill context but skip prompt enhancers — the repair prompt IS the instruction
        var skillCtx = (!isRepair && analysisResult && analysisResult.skills && analysisResult.skills.length > 0)
            ? buildSkillContext(analysisResult.skills, isFather) : "";
        var activeTier = (analysisResult && analysisResult.modelTier) ? normalizeModelTier(analysisResult.modelTier) : (isHard ? "medium" : "small");
        // Repair sessions use medium tier minimum for better reasoning about what went wrong
        if (isRepair && activeTier === "small") activeTier = "medium";
        var tierFallbackTried = false;

        while (attempts <= maxRetries) {
            attempts++;
            var modeLabel = isFather ? "[Father's Money] " : (isGold ? "[Gold] " : (isHard ? "[Hard] " : (isRepair ? "[Repair] " : "[Normal] ")));
            if (statusFn) statusFn(modeLabel + "Calling " + model + " [" + activeTier.toUpperCase() + "] (attempt " + attempts + ")...");

            var sysPrompt = isHard
                ? buildAgentSystemPromptHardMode(userRequest, skillCtx)
                : buildAgentSystemPrompt(userRequest, skillCtx);

            if (isRepair) {
                // Repair framing: the model knows it's fixing specific failures, not re-planning
                sysPrompt += "\n\nREPAIR SESSION OVERRIDE:\n" +
                    "- You are fixing specific failed tool calls from a completed run.\n" +
                    "- Do NOT re-plan the entire project from scratch.\n" +
                    "- Only output corrective calls for the failures listed in the user message.\n" +
                    "- Use alternative tools or args if the original approach is broken.\n" +
                    "- Max " + maxBatchCalls + " calls. Do not repeat already-succeeded steps.";
            }

            if (isFather) {
                sysPrompt += "\n\nFATHER'S MONEY MODE ACTIVE:\n" +
                    "- You may use all enabled skills aggressively.\n" +
                    "- Use bridge tools (library + generators) when helpful.\n" +
                    "- Optimize for completeness and quality over token cost.";
            }

            var userMsg = isRepair
                ? ("Fix the failed steps listed above. Max " + maxBatchCalls + " corrective calls only.")
                : (isHard
                    ? "Build the complete plan. Use as many tool calls as needed. Be thorough."
                    : "Generate the Balongra Agent plan now.");
            var maxTokens = isFather ? 24576 : (isGold ? 16384 : (isHard ? 12288 : (isRepair ? 6144 : 4096)));
            var payloadStr = buildPayload(model, sysPrompt, userMsg, maxTokens, activeTier);
            var req = callModelJSON(model, apiKey, apiUrl, payloadStr, isFather ? 140 : 90, statusFn, "agent " + (isRepair ? "repair" : "planning"));
            if (!req.ok) {
                var eLow = (req.error || "").toLowerCase();
                var modelRejected = (eLow.indexOf("model") !== -1 &&
                    (eLow.indexOf("not found") !== -1 || eLow.indexOf("unsupported") !== -1 ||
                        eLow.indexOf("invalid model") !== -1 || eLow.indexOf("does not exist") !== -1));
                if (!tierFallbackTried && activeTier !== "small" && modelRejected) {
                    tierFallbackTried = true;
                    activeTier = "small";
                    if (statusFn) statusFn("Provider rejected requested model tier. Falling back to SMALL tier...");
                    continue;
                }
                if (attempts <= maxRetries) continue;
                if (statusFn) statusFn(req.error);
                return null;
            }

            var rawContent = extractModelText(model, req.json);
            if (!rawContent || rawContent === "") {
                if (attempts <= maxRetries) continue;
                if (statusFn) statusFn("ERROR: Unexpected API response shape (no text content).");
                return null;
            }

            var agentPlan = extractJSON(rawContent);
            if (!agentPlan) {
                var arrPlan = extractJSONArray(rawContent);
                if (arrPlan && arrPlan instanceof Array) {
                    agentPlan = { plan: "Execute recovered tool-call array.", tool_calls: arrPlan };
                }
            }

            var normalized = normalizeAgentPlan(agentPlan, analysisResult);
            if (!normalized.ok) {
                if (attempts <= maxRetries) continue;
                var warnPreview = "";
                if (normalized.warnings && normalized.warnings.length > 0) {
                    warnPreview = " Notes: " + shortPreview(normalized.warnings.join(" | "), 240);
                }
                if (statusFn) statusFn("ERROR: AI did not return an executable plan." + warnPreview + " Preview: " + shortPreview(rawContent, 220));
                return null;
            }

            if (normalized.warnings && normalized.warnings.length > 0 && statusFn) {
                statusFn("Plan normalized with " + normalized.warnings.length + " note(s).");
            }
            return {
                plan: normalized.plan,
                tool_calls: normalized.tool_calls,
                warnings: normalized.warnings || [],
                done: false
            };
        }
        return null;
    }

    // callAgentRepairAPI removed — auto-repair disabled (single-shot architecture, use Undo to retry)

    // Build UI
    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel) ? thisObj : new Window("palette", scriptName, undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["fill", "fill"];
        win.spacing = 5;
        win.margins = 10;

        // Dark premium palette for AE workflows
        var colorPaper = [0.11, 0.11, 0.12];
        var colorCard = [0.16, 0.16, 0.18];
        var colorInk = [0.92, 0.92, 0.93];
        var colorMuted = [0.67, 0.67, 0.70];
        var colorLine = [0.30, 0.30, 0.34];
        var colorDanger = [0.74, 0.22, 0.22];
        var colorOrange = [0.95, 0.45, 0.20];
        var colorPurple = [0.45, 0.43, 0.95];
        var colorSteel = [0.24, 0.24, 0.28];

        var uiTokens = {
            spacingXS: 3,
            spacingSM: 5,
            spacingMD: 8,
            spacingLG: 12,
            rowHeight: 28,
            rowHeightLarge: 34,
            panelMargin: 10,
            borderAlpha: 1
        };
        // Performance mode keeps UI responsive in ScriptUI-heavy panels.
        var uiPerfMode = true;
        var responsiveButtonRows = [];
        var responsiveCompactRows = [];
        var responsiveSingleButtons = [];

        function makePen(gfx, rgb) {
            return gfx.newPen(gfx.PenType.SOLID_COLOR, rgb, 1);
        }

        function makeBrush(gfx, rgb) {
            return gfx.newBrush(gfx.BrushType.SOLID_COLOR, rgb);
        }

        function fontOrFallback(gfx, names, style, size) {
            for (var fi = 0; fi < names.length; fi++) {
                try {
                    return ScriptUI.newFont(names[fi], style, size);
                } catch (e) { }
            }
            try {
                var base = gfx.font ? gfx.font.name : "Tahoma";
                return ScriptUI.newFont(base, style, size);
            } catch (baseErr) {
                return gfx.font;
            }
        }

        function applyTextStyle(ctrl, kind) {
            try {
                var g = ctrl.graphics;
                if (kind === "title") g.font = fontOrFallback(g, ["American Typewriter", "Courier New", "Menlo"], "BOLD", 17);
                else if (kind === "label") g.font = fontOrFallback(g, ["American Typewriter", "Courier New", "Menlo"], "BOLD", 12);
                else if (kind === "mono") g.font = fontOrFallback(g, ["Courier New", "Menlo", "Monaco"], "REGULAR", 12);
                else g.font = fontOrFallback(g, ["Courier New", "Menlo", "Monaco"], "REGULAR", 11);
                g.foregroundColor = makePen(g, (kind === "subtle") ? colorMuted : colorInk);
            } catch (e) { }
        }

        function styleInput(ctrl, mono) {
            try {
                var g = ctrl.graphics;
                // Compatibility-first: avoid forcing foreground/background colors on edittext.
                // Some AE hosts render custom edittext colors with low contrast or clipped painting.
                g.font = mono
                    ? fontOrFallback(g, ["Courier New", "Menlo", "Monaco"], "REGULAR", 12)
                    : fontOrFallback(g, ["American Typewriter", "Courier New"], "REGULAR", 11);
            } catch (e) { }
        }

        function styleListBox(ctrl) {
            try {
                var g = ctrl.graphics;
                // Keep native list rendering for reliable item visibility in AE ScriptUI.
                // Forced dark backgrounds can hide text on some hosts/themes.
                g.font = fontOrFallback(g, ["Courier New", "Menlo", "Monaco"], "REGULAR", 11);
            } catch (e) { }
        }

        function clampNum(v, minV, maxV) {
            return Math.max(minV, Math.min(maxV, v));
        }

        function sizePrimaryRow(row, baseMinW) {
            if (!row) return;
            var btnCount = 0;
            var i;
            for (i = 0; i < row.children.length; i++) {
                if (row.children[i].type === "button") btnCount++;
            }
            if (btnCount === 0) return;

            var panelW = (win.size && win.size[0]) ? win.size[0] : 480;
            var panelH = (win.size && win.size[1]) ? win.size[1] : 640;
            var rowHeight = clampNum(Math.round(panelH * 0.048), 24, 46);
            var avail = (row.size && row.size[0] > 0) ? row.size[0] : Math.max(300, panelW - 40);
            var spacing = (row.spacing !== undefined && row.spacing !== null) ? row.spacing : uiTokens.spacingXS;
            var eachW = Math.floor((avail - (spacing * (btnCount - 1))) / btnCount);
            eachW = Math.max(baseMinW || 90, eachW);

            for (i = 0; i < row.children.length; i++) {
                var c = row.children[i];
                if (c.type === "button") {
                    c.preferredSize = [eachW, rowHeight];
                    c.minimumSize = [Math.max(70, Math.round(eachW * 0.55)), 24];
                }
            }
            row.minimumSize = [-1, 24];
        }

        function sizeCompactRow(row) {
            if (!row) return;
            var panelH = (win.size && win.size[1]) ? win.size[1] : 640;
            var h = clampNum(Math.round(panelH * 0.043), 24, 38);

            for (var i = 0; i < row.children.length; i++) {
                var c = row.children[i];
                if (c.type === "button") {
                    var prefW = (c.preferredSize && c.preferredSize[0] > 0) ? c.preferredSize[0] : -1;
                    if (prefW > 0 && prefW < 38) prefW = clampNum(Math.round(prefW * (h / 24)), 24, 52);
                    c.preferredSize = [prefW, h];
                    c.minimumSize = [(prefW > 0 ? Math.max(24, Math.round(prefW * 0.8)) : -1), 24];
                }
            }
            row.minimumSize = [-1, 24];
        }

        function sizeSingleButton(btn, baseW) {
            if (!btn) return;
            var panelW = (win.size && win.size[0]) ? win.size[0] : 480;
            var panelH = (win.size && win.size[1]) ? win.size[1] : 640;
            var h = clampNum(Math.round(panelH * 0.048), 24, 46);
            var w;
            if (baseW && baseW > 0) w = clampNum(Math.round(baseW + (panelW - 420) * 0.28), baseW, Math.max(baseW + 120, baseW));
            else w = -1;
            btn.preferredSize = [w, h];
            btn.minimumSize = [(w > 0 ? Math.max(80, Math.round(w * 0.7)) : -1), 24];
        }

        function makeTagButton(par, label, tagKey) {
            var b = buildColBtn(par, label, colorSteel);
            b._tagKey = tagKey;
            b._activeTag = false;
            if (uiPerfMode) {
                b.setActive = function (active) {
                    this._activeTag = !!active;
                    this.text = (this._activeTag ? "● " : "") + label;
                };
                return b;
            }
            b.setActive = function (active) {
                this._activeTag = !!active;
                this._baseColor = this._activeTag ? colorOrange : colorSteel;
                this.notify("onDraw");
            };
            // overwrite draw color dynamically by hijacking updateText with same label
            b.onDraw = (function (origDraw, btnRef) {
                return function () {
                    var originalColor = btnRef._activeTag ? colorOrange : colorSteel;
                    var prev = btnRef._tempColor;
                    btnRef._tempColor = originalColor;
                    var gFX = this.graphics;
                    var w = this.size[0];
                    var h = this.size[1];
                    var bg = originalColor;
                    gFX.newPath();
                    gFX.rectPath(0, 0, w, h);
                    gFX.fillPath(makeBrush(gFX, bg));
                    gFX.newPath();
                    gFX.rectPath(0, 0, w, h);
                    gFX.strokePath(makePen(gFX, colorLine));
                    var f = fontOrFallback(gFX, ["American Typewriter", "Courier New", "Menlo"], "BOLD", 11);
                    var measured = gFX.measureString(label, f, w);
                    var txtW = (typeof measured === "number") ? measured : measured.width || 0;
                    gFX.drawString(label, makePen(gFX, [0.95, 0.95, 0.96]), Math.max(6, (w - txtW) / 2), Math.max(2, (h - 13) / 2), f);
                    btnRef._tempColor = prev;
                };
            })(b.onDraw, b);
            return b;
        }

        win.graphics.backgroundColor = makeBrush(win.graphics, colorPaper);

        function buildColBtn(par, label, bgRgb) {
            var btn = par.add("button", undefined, label);
            btn.alignment = ["center", "center"];
            btn.preferredSize = [-1, uiTokens.rowHeight];
            btn.minimumSize = [-1, 24];
            btn._label = label;
            if (uiPerfMode) {
                btn.updateText = function (s) { label = s; btn._label = s; btn.text = s; };
                btn.setHelp = function (s) { btn.helpTip = s; };
                return btn;
            }
            var isPressed = false;

            btn.addEventListener("mousedown", function () { isPressed = true; btn.notify("onDraw"); });
            btn.addEventListener("mouseup", function () { isPressed = false; btn.notify("onDraw"); });
            btn.addEventListener("mouseout", function () { isPressed = false; btn.notify("onDraw"); });

            var cachedFont = null;
            var cachedStrokePen = null;
            var cachedBgBrush = null;
            var cachedBgPressedBrush = null;
            var cachedTextPen = null;

            btn.onDraw = function () {
                var gFX = this.graphics;
                var w = this.size[0];
                var h = this.size[1];

                if (!cachedFont) cachedFont = fontOrFallback(gFX, ["American Typewriter", "Courier New", "Menlo"], "BOLD", 12);
                if (!cachedStrokePen) cachedStrokePen = makePen(gFX, colorLine);
                if (!cachedBgBrush) cachedBgBrush = makeBrush(gFX, bgRgb);
                if (!cachedBgPressedBrush) cachedBgPressedBrush = makeBrush(gFX, [bgRgb[0] * 0.8, bgRgb[1] * 0.8, bgRgb[2] * 0.8]);
                
                var bgBrush = isPressed ? cachedBgPressedBrush : cachedBgBrush;
                
                if (!cachedTextPen) {
                    var luminance = (bgRgb[0] * 0.299) + (bgRgb[1] * 0.587) + (bgRgb[2] * 0.114);
                    var fg = (luminance < 0.45) ? [0.99, 0.99, 0.98] : colorInk;
                    cachedTextPen = makePen(gFX, fg);
                }

                gFX.newPath();
                gFX.rectPath(0, 0, w, h);
                gFX.fillPath(bgBrush);

                gFX.newPath();
                gFX.rectPath(0, 0, w, h);
                gFX.strokePath(cachedStrokePen);

                var measured = gFX.measureString(label, cachedFont, w);
                var txtW = (typeof measured === "number") ? measured : measured.width || 0;
                var tx = Math.max(6, (w - txtW) / 2);
                var ty = Math.max(2, (h - 14) / 2);
                gFX.drawString(label, cachedTextPen, tx, ty, cachedFont);
            };

            btn.updateText = function (s) { label = s; btn.text = s; btn.notify("onDraw"); };
            btn.setHelp = function (s) { btn.helpTip = s; };
            return btn;
        }

        function buildTabBtn(par, label) {
            var btn = par.add("button", undefined, label);
            btn.preferredSize = [-1, uiTokens.rowHeight];
            btn.minimumSize = [72, 24];
            btn.alignment = ["left", "center"];
            btn._label = label;
            btn._active = false;
            if (uiPerfMode) return btn;
            btn._pressed = false;

            btn.addEventListener("mousedown", function () { btn._pressed = true; btn.notify("onDraw"); });
            btn.addEventListener("mouseup", function () { btn._pressed = false; btn.notify("onDraw"); });
            btn.addEventListener("mouseout", function () { btn._pressed = false; btn.notify("onDraw"); });

            var cachedFontBold = null;
            var cachedFontReg = null;
            var cachedPenStroke = null;
            
            var cachedBgAct = null;
            var cachedBgInact = null;
            var cachedBgActPress = null;
            var cachedBgInactPress = null;
            
            var cachedPenAct = null;
            var cachedPenInact = null;

            btn.onDraw = function () {
                var g = this.graphics;
                var w = this.size[0];
                var h = this.size[1];

                if (!cachedBgAct) cachedBgAct = makeBrush(g, [0.08, 0.08, 0.09]);
                if (!cachedBgInact) cachedBgInact = makeBrush(g, [0.22, 0.22, 0.25]);
                if (!cachedBgActPress) cachedBgActPress = makeBrush(g, [0.05, 0.05, 0.06]);
                if (!cachedBgInactPress) cachedBgInactPress = makeBrush(g, [0.18, 0.18, 0.20]);
                
                var bgBrush = this._active ? cachedBgAct : cachedBgInact;
                if (this._pressed) {
                    bgBrush = this._active ? cachedBgActPress : cachedBgInactPress;
                }

                if (!cachedPenAct) cachedPenAct = makePen(g, [0.99, 0.99, 0.99]);
                if (!cachedPenInact) cachedPenInact = makePen(g, [0.84, 0.84, 0.86]);
                var fgPen = this._active ? cachedPenAct : cachedPenInact;

                g.newPath();
                g.rectPath(0, 0, w, h);
                g.fillPath(bgBrush);

                g.newPath();
                g.rectPath(0, 0, w, h);
                if (!cachedPenStroke) cachedPenStroke = makePen(g, colorLine);
                g.strokePath(cachedPenStroke);

                if (!cachedFontBold) cachedFontBold = fontOrFallback(g, ["American Typewriter", "Courier New", "Menlo"], "BOLD", 11);
                if (!cachedFontReg) cachedFontReg = fontOrFallback(g, ["American Typewriter", "Courier New", "Menlo"], "REGULAR", 11);
                var f = this._active ? cachedFontBold : cachedFontReg;

                var measured = g.measureString(label, f, w);
                var txtW = (typeof measured === "number") ? measured : measured.width || 0;
                g.drawString(label, fgPen, Math.max(8, (w - txtW) / 2), Math.max(2, (h - 13) / 2), f);
            };

            return btn;
        }

        function setTabState(btn, active) {
            if (!btn) return;
            btn._active = !!active;
            if (uiPerfMode) {
                btn.text = btn._active ? ("■ " + (btn._label || btn.text)) : (btn._label || btn.text);
                return;
            }
            btn.notify("onDraw");
        }

        function buildGlassPanel(par, label) {
            // Native panel is much more reliable in ScriptUI than custom-drawn groups.
            var p = par.add("panel", undefined, label ? label.toUpperCase() : "");
            p.orientation = "column";
            p.alignChildren = ["fill", "top"];
            p.alignment = ["fill", "fill"];
            p.spacing = 6;
            p.margins = [10, 18, 10, 10];
            return p;
        }

        function containsRiskyScriptOps(scriptStr) {
            if (!scriptStr) return false;
            var risky = [
                /\bsystem\.callSystem\b/i,
                /\bFile\s*\(/,
                /\bFolder\s*\(/,
                /\.open\s*\(/,
                /\.remove\s*\(/,
                /\.execute\s*\(/,
                /\bapp\.quit\b/i,
                /\bapp\.project\.close\b/i,
                /\bapp\.project\.save\b/i,
                /\bSocket\s*\(/,
                /\bExternalObject\b/
            ];
            for (var i = 0; i < risky.length; i++) {
                if (risky[i].test(scriptStr)) return true;
            }
            return false;
        }

        function getRiskyAgentStepReason(call) {
            var toolName = call.tool || call.name || "";
            var args = call.args || call.parameters || call.input || {};
            if (toolName === "executeExtendScript") {
                if (containsRiskyScriptOps(args.script || "")) return "executeExtendScript with file/system/project operations";
                return "executeExtendScript";
            }
            if (toolName === "runLibraryScript") return "runLibraryScript (executes stored script code)";
            if (toolName === "generateScriptFromPrompt" && args.runNow === true) return "generateScriptFromPrompt with runNow=true";
            if (toolName === "removeExpression") return "removeExpression";
            if (toolName === "precomposeLayer") return "precomposeLayer (timeline restructuring)";
            // deleteLayer is irreversible without Undo — always confirm
            if (toolName === "deleteLayer") return "deleteLayer: will permanently remove layer '" + (args.layerName || "?") + "' (use Undo Last Run to reverse)";
            return "";
        }

        // Header & Tabs Navigation
        var topNavGroup = win.add("group");
        topNavGroup.orientation = "column";
        topNavGroup.alignment = ["fill", "top"];
        topNavGroup.alignChildren = ["fill", "top"];
        topNavGroup.spacing = 4;

        var mastRow = topNavGroup.add("group");
        mastRow.orientation = "row";
        mastRow.alignment = ["fill", "top"];
        mastRow.alignChildren = ["left", "center"];

        var title = mastRow.add("statictext", undefined, "Balongra AI agent");
        applyTextStyle(title, "title");

        var mastSpacer = mastRow.add("group");
        mastSpacer.alignment = ["fill", "fill"];

        var authorText = mastRow.add("statictext", undefined, "made with \u2665 by Asif Gondal");
        authorText.alignment = ["right", "center"];
        applyTextStyle(authorText, "subtle");

        var navBar = topNavGroup.add("group");
        navBar.orientation = "row";
        navBar.alignment = ["fill", "top"];
        navBar.alignChildren = ["fill", "center"];
        navBar.spacing = uiTokens.spacingSM;
        navBar.minimumSize = [-1, uiTokens.rowHeight];

        var btnTabExpr = buildTabBtn(navBar, "EXPRESSIONS");
        var btnTabScript = buildTabBtn(navBar, "SCRIPTS");
        var btnTabTools = buildTabBtn(navBar, "TOOLS + SETTINGS");
        var btnTabAgent = buildTabBtn(navBar, "AGENT");

        // Main Container for Tabs
        var mainContainer = win.add("group");
        mainContainer.orientation = "stack"; // Stack allows overlapping panels
        mainContainer.alignment = ["fill", "fill"];
        mainContainer.alignChildren = ["fill", "fill"];

        // ==========================================
        // TAB 1: EXPRESSIONS
        // ==========================================
        tabs.expr = mainContainer.add("group");
        tabs.expr.orientation = "column";
        tabs.expr.alignChildren = ["fill", "fill"]; // Allow vertical expansion
        tabs.expr.alignment = ["fill", "fill"];
        tabs.expr.spacing = uiTokens.spacingSM;

        // Search + filter + sorting
        var filterGroup = tabs.expr.add("group");
        filterGroup.orientation = "row";
        filterGroup.alignment = ["fill", "top"];
        filterGroup.alignChildren = ["left", "center"];
        filterGroup.spacing = uiTokens.spacingSM;
        filterGroup.minimumSize = [-1, uiTokens.rowHeight];

        var groupDropdown = filterGroup.add("dropdownlist", undefined, availableGroups);
        groupDropdown.selection = 0;
        groupDropdown.preferredSize = [156, uiTokens.rowHeight];
        groupDropdown.minimumSize = [120, 24];

        var sortDropdown = filterGroup.add("dropdownlist", undefined, ["Most Used", "Recently Added", "A-Z"]);
        sortDropdown.selection = 0;
        sortDropdown.preferredSize = [140, uiTokens.rowHeight];
        sortDropdown.minimumSize = [110, 24];

        var searchInput = filterGroup.add("edittext", undefined, "");
        searchInput.alignment = ["fill", "center"];
        searchInput.preferredSize = [-1, uiTokens.rowHeight];
        searchInput.helpTip = "Search expressions by name, behavior, property, or keyword";
        searchInput.minimumSize = [140, 24];

        var searchClearBtn = buildColBtn(filterGroup, "CLEAR", colorSteel);
        searchClearBtn.preferredSize = [88, uiTokens.rowHeight];

        styleInput(searchInput, true);
        applyTextStyle(groupDropdown, "mono");
        applyTextStyle(sortDropdown, "mono");

        var tagRow = tabs.expr.add("group");
        tagRow.orientation = "row";
        tagRow.alignment = ["fill", "top"];
        tagRow.alignChildren = ["left", "center"];
        tagRow.spacing = uiTokens.spacingXS;
        tagRow.minimumSize = [-1, 24];

        var tagLabel = tagRow.add("statictext", undefined, "Quick Tags:");
        applyTextStyle(tagLabel, "subtle");
        var tagBtnAll = makeTagButton(tagRow, "ALL", "All");
        var tagBtnMotion = makeTagButton(tagRow, "MOTION", "Motion");
        var tagBtnText = makeTagButton(tagRow, "TEXT", "Text");
        var tagBtnLoop = makeTagButton(tagRow, "LOOP", "Loop");
        var tagBtnMath = makeTagButton(tagRow, "MATH", "Math");
        var tagBtnUtility = makeTagButton(tagRow, "UTILITY", "Utility");
        var tagButtons = [tagBtnAll, tagBtnMotion, tagBtnText, tagBtnLoop, tagBtnMath, tagBtnUtility];
        tagBtnAll.setActive(true);

        function selectDropdownValue(dropdown, value) {
            if (!dropdown || !value) return false;
            for (var d = 0; d < dropdown.items.length; d++) {
                if (dropdown.items[d].text === value) {
                    dropdown.selection = d;
                    return true;
                }
            }
            return false;
        }

        function setTagFilter(tagValue, skipSave) {
            currentTagFilter = tagValue || "All";
            for (var tb = 0; tb < tagButtons.length; tb++) {
                tagButtons[tb].setActive(tagButtons[tb]._tagKey === currentTagFilter);
            }
            uiState.lastTagFilter = currentTagFilter;
        }

        // Main workflow containers: List + Actions first, Builder second, Editor third
        var exprListContainer = tabs.expr.add("group");
        exprListContainer.orientation = "column";
        exprListContainer.alignChildren = ["fill", "fill"];
        exprListContainer.alignment = ["fill", "fill"];
        exprListContainer.spacing = uiTokens.spacingSM;

        var exprBuilderContainer = tabs.expr.add("group");
        exprBuilderContainer.orientation = "column";
        exprBuilderContainer.alignChildren = ["fill", "top"];
        exprBuilderContainer.alignment = ["fill", "top"];

        // Expression List
        var listGroup = buildGlassPanel(exprListContainer, "Expression Library");
        listGroup.orientation = "column";
        listGroup.alignment = ["fill", "fill"]; // This group fills all remaining vertical space
        listGroup.alignChildren = ["fill", "top"];
        listGroup.spacing = uiTokens.spacingXS;
        listGroup.margins = uiTokens.panelMargin;

        var expressionList = listGroup.add("listbox", undefined, [], {
            numberOfColumns: 2,
            showHeaders: true,
            columnTitles: ["Name", "Target"]
        });
        expressionList.preferredSize = [-1, 150]; // Flexible height, minimum 150px
        expressionList.minimumSize = [-1, 120];
        expressionList.alignment = ["fill", "fill"]; // List fills its parent completely
        styleListBox(expressionList);

        // Action buttons container for expressions list (Fluid Layout)
        var listActionsGroup = listGroup.add("group");
        listActionsGroup.orientation = "row";
        listActionsGroup.alignment = ["fill", "bottom"];
        listActionsGroup.alignChildren = ["fill", "center"];
        listActionsGroup.spacing = uiTokens.spacingXS;
        listActionsGroup.preferredSize = [-1, uiTokens.rowHeight];
        listActionsGroup.minimumSize = [-1, 24];

        var moveUpBtn = listActionsGroup.add("button", undefined, "↑");
        moveUpBtn.preferredSize = [24, 24];
        moveUpBtn.helpTip = "Move selected expression UP in library";

        var moveDownBtn = listActionsGroup.add("button", undefined, "↓");
        moveDownBtn.preferredSize = [24, 24];
        moveDownBtn.helpTip = "Move selected expression DOWN in library";

        var clearBtn = listActionsGroup.add("button", undefined, "✕ Clr");
        clearBtn.helpTip = "Removes expression from selected properties";

        var clearLayersBtn = buildColBtn(listActionsGroup, "⌫ Lyr", colorDanger);
        clearLayersBtn.alignment = ["fill", "center"];
        clearLayersBtn.helpTip = "Removes ALL expressions from selected LAYERS (recursive)";

        var duplicateBtn = listActionsGroup.add("button", undefined, "⎘ Dup");
        duplicateBtn.helpTip = "Duplicate selected expression as a new variant";

        var favBtn = listActionsGroup.add("button", undefined, "★");
        favBtn.preferredSize = [24, 24];
        favBtn.helpTip = "Toggle Favorite on selected expression";

        var deleteBtn = listActionsGroup.add("button", undefined, "⌫ Del");

        var applyBtn = buildColBtn(listActionsGroup, "► Apply", colorOrange);
        applyBtn.alignment = ["fill", "center"];
        applyBtn.setHelp("Smart Auto-Bind: Select a layer to automatically apply to target property");

        // Expression count indicator
        var countLabel = listGroup.add("statictext", undefined, "");
        countLabel.alignment = ["fill", "bottom"];
        applyTextStyle(countLabel, "subtle");

        // Expression Builder (after list/actions)
        var exprAiPanel = buildGlassPanel(exprBuilderContainer, "Expression Builder");
        exprAiPanel.orientation = "column";
        exprAiPanel.alignChildren = ["fill", "top"];
        exprAiPanel.alignment = ["fill", "top"];
        exprAiPanel.margins = uiTokens.panelMargin;

        var exprAiTag = exprAiPanel.add("statictext", undefined,
            "Describe behavior in plain language, then preview and apply or save to library.",
            { multiline: true });
        exprAiTag.preferredSize = [-1, 24];
        applyTextStyle(exprAiTag, "subtle");

        var exprAiActionRow = exprAiPanel.add("group");
        exprAiActionRow.orientation = "row";
        exprAiActionRow.alignChildren = ["fill", "center"];
        exprAiActionRow.alignment = ["fill", "top"];
        exprAiActionRow.spacing = uiTokens.spacingSM;
        exprAiActionRow.minimumSize = [-1, uiTokens.rowHeight];

        var btnAIDirect = buildColBtn(exprAiActionRow, "GENERATE EXPRESSION", colorOrange);
        btnAIDirect.preferredSize = [-1, uiTokens.rowHeightLarge];

        var btnAICreate = buildColBtn(exprAiActionRow, "MANUAL PROMPT", colorSteel);
        btnAICreate.preferredSize = [-1, uiTokens.rowHeightLarge];

        var btnAIImport = buildColBtn(exprAiActionRow, "IMPORT JSON", colorSteel);
        btnAIImport.preferredSize = [-1, uiTokens.rowHeightLarge];

        // Toggle button for showing/hiding edit panel
        var toggleEditBtn = buildColBtn(tabs.expr, "⊞ ADD NEW EXPRESSION", colorSteel);
        toggleEditBtn.alignment = ["fill", "bottom"];
        toggleEditBtn.minimumSize = [-1, 24];

        // Add/Edit Expression Section (collapsible)
        var editGroup = buildGlassPanel(tabs.expr, "Expression Editor");
        editGroup.orientation = "column";
        editGroup.alignment = ["fill", "bottom"];
        editGroup.alignChildren = ["fill", "top"];
        editGroup.spacing = 3;
        editGroup.margins = 8;
        editGroup.visible = false; // Hidden by default

        // Name input
        var nameGroup = editGroup.add("group");
        nameGroup.orientation = "column";
        nameGroup.alignChildren = ["fill", "top"];
        nameGroup.spacing = 0;
        var nameLbl = nameGroup.add("statictext", undefined, "Name:");
        applyTextStyle(nameLbl, "label");
        var nameInput = nameGroup.add("edittext", undefined, "");
        nameInput.preferredSize = [-1, 20];
        styleInput(nameInput, false);

        // Two-column dropdown row
        var comboRow = editGroup.add("group");
        comboRow.orientation = "row";
        comboRow.alignment = ["fill", "top"];
        comboRow.alignChildren = ["fill", "top"];

        // Category dropdown
        var catGroup = comboRow.add("group");
        catGroup.orientation = "column";
        catGroup.alignment = ["fill", "top"];
        catGroup.alignChildren = ["fill", "top"];
        catGroup.spacing = 0;
        var catLbl = catGroup.add("statictext", undefined, "Category:");
        applyTextStyle(catLbl, "label");
        // Exclude "All Groups" and "★ Favorites" from assignable categories
        var assignableGroups = [];
        for (var ag = 0; ag < availableGroups.length; ag++) {
            if (availableGroups[ag] !== "All Groups" && availableGroups[ag] !== "★ Favorites") {
                assignableGroups.push(availableGroups[ag]);
            }
        }
        var editGroupDropdown = catGroup.add("dropdownlist", undefined, assignableGroups);
        editGroupDropdown.selection = 0;
        editGroupDropdown.preferredSize = [-1, 20];
        applyTextStyle(editGroupDropdown, "mono");

        // Target Property dropdown
        var targetGroup = comboRow.add("group");
        targetGroup.orientation = "column";
        targetGroup.alignment = ["fill", "top"];
        targetGroup.alignChildren = ["fill", "top"];
        targetGroup.spacing = 0;
        var targetLbl = targetGroup.add("statictext", undefined, "Target Property:");
        applyTextStyle(targetLbl, "label");
        var targetDropdown = targetGroup.add("dropdownlist", undefined, [
            "Position",
            "Rotation",
            "Rotation X",
            "Rotation Y",
            "Rotation Z",
            "Scale",
            "Opacity",
            "Anchor Point",
            "Time Remap",
            "Effects (Custom)",
            "Source Text",
            "Path",
            "Stroke Width",
            "Color",
            "Any Property (Manual)"
        ]);
        targetDropdown.selection = 0;
        targetDropdown.preferredSize = [-1, 20];
        applyTextStyle(targetDropdown, "mono");

        // Description input
        var descGroup = editGroup.add("group");
        descGroup.orientation = "column";
        descGroup.alignChildren = ["fill", "top"];
        descGroup.spacing = 0;
        var descLbl = descGroup.add("statictext", undefined, "Description:");
        applyTextStyle(descLbl, "label");
        var descInput = descGroup.add("edittext", undefined, "");
        descInput.preferredSize = [-1, 20];
        styleInput(descInput, false);

        // Expression input
        var exprCodeLbl = editGroup.add("statictext", undefined, "Expression Code:");
        applyTextStyle(exprCodeLbl, "label");
        var exprInput = editGroup.add("edittext", undefined, "", { multiline: true, scrolling: true });
        exprInput.preferredSize = [-1, 80];
        styleInput(exprInput, true);

        // Action buttons
        var actionButtonGroup = editGroup.add("group");
        actionButtonGroup.orientation = "row";
        actionButtonGroup.alignment = "fill";
        actionButtonGroup.alignChildren = ["fill", "center"];

        var saveBtn = actionButtonGroup.add("button", undefined, "Save");
        var updateBtn = actionButtonGroup.add("button", undefined, "Update");
        var cancelBtn = actionButtonGroup.add("button", undefined, "Cancel");

        updateBtn.visible = false; // Only show in edit mode

        // ==========================================
        // TAB 2: SCRIPTS
        // ==========================================
        tabs.script = mainContainer.add("group");
        tabs.script.orientation = "column";
        tabs.script.alignChildren = ["fill", "fill"];
        tabs.script.alignment = ["fill", "fill"];
        tabs.script.visible = false;
        tabs.script.spacing = uiTokens.spacingSM;

        // Script List
        var scListGroup = buildGlassPanel(tabs.script, "ExtendScript Library");
        scListGroup.orientation = "column";
        scListGroup.alignChildren = ["fill", "top"];
        scListGroup.alignment = ["fill", "fill"];
        scListGroup.spacing = uiTokens.spacingXS;
        scListGroup.margins = uiTokens.panelMargin;

        var scriptList = scListGroup.add("listbox", undefined, [], {
            numberOfColumns: 1,
            showHeaders: true,
            columnTitles: ["Script Name"]
        });
        scriptList.preferredSize = [-1, 150];
        scriptList.minimumSize = [-1, 120];
        scriptList.alignment = ["fill", "fill"];
        styleListBox(scriptList);

        // Action buttons
        var scActions = scListGroup.add("group");
        scActions.orientation = "row";
        scActions.alignment = ["fill", "bottom"];
        scActions.alignChildren = ["fill", "center"];
        scActions.preferredSize = [-1, uiTokens.rowHeight];
        scActions.minimumSize = [-1, 24];

        var editScBtn = scActions.add("button", undefined, "⎘ Edit");
        var delScBtn = scActions.add("button", undefined, "⌫ Delete");
        var runScBtn = buildColBtn(scActions, "► Run Script", colorPurple);
        runScBtn.alignment = ["fill", "center"];

        var agentRow = tabs.script.add("group");
        agentRow.orientation = "row";
        agentRow.alignChildren = ["fill", "top"];
        agentRow.alignment = ["fill", "top"];
        agentRow.spacing = uiTokens.spacingSM;
        agentRow.minimumSize = [-1, uiTokens.rowHeight];

        var btnAIScript = buildColBtn(agentRow, "✧ Auto-Generate Script", colorOrange);
        btnAIScript.preferredSize = [-1, uiTokens.rowHeight];

        var btnAIAgent = buildColBtn(agentRow, "🤖 Full AI Workflow", [0.4, 0.4, 0.9, 1]);
        btnAIAgent.preferredSize = [-1, uiTokens.rowHeight];


        btnAIAgent.onClick = function () {
            switchTab('agent');
            agentPromptInput.text = "Create a 1920x1080 comp named 'AI Gen' with a 500x500 white solid.";
        };




        btnAIScript.onClick = function () {
            var model = apiDropdown.selection ? apiDropdown.selection.text : apiSettings.activeModel;
            var conn = resolveModelConnection(model, true);
            var apiKey = conn.apiKey;
            var apiUrl = conn.apiUrl;

            if (conn.keyRequired && (!apiKey || apiKey === "")) {
                alert("Your " + model + " API key is empty.\n\nPaste it in API Settings and click Save.");
                return;
            }
            if (!apiUrl || apiUrl === "") {
                alert("No API endpoint configured for " + model + ".\n\nSet it in API Settings and click Save API Keys.");
                return;
            }

            // Prompt dialog
            var userInput = null;
            var scPromptWin = new Window("dialog", "\u2727 Auto-Generate Script");
            scPromptWin.orientation = "column";
            scPromptWin.alignChildren = ["fill", "top"];
            scPromptWin.add("statictext", undefined, "What should this script do? (e.g., 'Center anchor point of all selected layers')");
            var scPInput = scPromptWin.add("edittext", undefined, "", { multiline: true });
            scPInput.preferredSize = [380, 80];
            scPInput.active = true;

            var scPBtnGrp = scPromptWin.add("group");
            scPBtnGrp.alignment = ["right", "center"];
            var scPCancel = scPBtnGrp.add("button", undefined, "Cancel");
            var scPOk = scPBtnGrp.add("button", undefined, "Generate");

            scPCancel.onClick = function () { scPromptWin.close(0); };
            scPOk.onClick = function () {
                if (scPInput.text !== "") {
                    userInput = scPInput.text;
                    scPromptWin.close(1);
                } else {
                    alert("Please enter a description.");
                }
            };

            scPromptWin.center();
            if (scPromptWin.show() === 0 || !userInput) return;

            // --- Internal AI caller for scripts ---
            function callScriptAI(description) {
                var maxRetries = 2;
                var attempts = 0;

                while (attempts <= maxRetries) {
                    attempts++;

                    var sysPrompt = buildScriptAISystemPrompt(description);
                    var payloadStr = buildPayload(model, sysPrompt, "Generate the After Effects script JSON now.");

                    var tmpFile = new File(Folder.temp.fullName + "/expresso_script_payload_attempt" + attempts + ".json");
                    try {
                        tmpFile.encoding = "UTF-8";
                        tmpFile.open("w");
                        tmpFile.write(payloadStr);
                        tmpFile.close();
                    } catch (fileErr) {
                        alert("Failed to write temp file: " + fileErr.toString());
                        return null;
                    }

                    // Build command
                    var sanitizedKey = apiKey.replace(/[^a-zA-Z0-9_.\-]/g, ""); // Shell injection mitigation — use local var to avoid mutating closure
                    var sanitizedUrl = (apiUrl || "").replace(/['"`$;&|<>\r\n\\]/g, "");
                    var cmd = "";
                    var isMac = ($.os.indexOf("Mac") !== -1);
                    if (isMac) {
                        var hdr = " -H 'Content-Type: application/json'";
                        if (modelUsesBearerAuth(model) && sanitizedKey !== "") hdr += " -H 'Authorization: Bearer " + sanitizedKey + "'";
                        if (model === "Claude") hdr += " -H 'x-api-key: " + sanitizedKey + "' -H 'anthropic-version: 2023-06-01'";
                        if (model === "Gemini" && sanitizedKey !== "") hdr += " -H 'x-goog-api-key: " + sanitizedKey + "'";
                        cmd = 'curl -s -X POST "' + sanitizedUrl + '"' + hdr + ' -d @"' + tmpFile.fsName + '"';
                    } else {
                        var psH = "@{'Content-Type'='application/json';";
                        if (modelUsesBearerAuth(model) && sanitizedKey !== "") psH += "'Authorization'='Bearer " + sanitizedKey + "'";
                        if (model === "Claude") psH += "'x-api-key'='" + sanitizedKey + "';'anthropic-version'='2023-06-01'";
                        if (model === "Gemini" && sanitizedKey !== "") psH += "'x-goog-api-key'='" + sanitizedKey + "'";
                        psH += "}";
                        cmd = "powershell -Command \"$body = Get-Content -Raw -Path '" + tmpFile.fsName.replace(/'/g, "''") + "'; (Invoke-WebRequest -Uri '" + sanitizedUrl.replace(/'/g, "''") + "' -Method Post -Headers " + psH + " -Body $body -ContentType 'application/json').Content\"";
                    }

                    // Execute (always cleanup temp file, even on shell failures)
                    var responseStr = "";
                    var shellErr = null;
                    try {
                        if (attempts > 1) {
                            btnAIScript.updateText("\u23f3 Retrying (" + (attempts - 1) + ")...");
                        } else {
                            btnAIScript.updateText("\u23f3 Generating...");
                        }
                        if (win.update) win.update();
                        responseStr = system.callSystem(cmd);
                    } catch (err) {
                        shellErr = err;
                    } finally {
                        btnAIScript.updateText("\u2727 Auto-Generate Script");
                        if (win.update) win.update();
                        try { if (tmpFile && tmpFile.exists) tmpFile.remove(); } catch (x) { }
                    }
                    if (shellErr) {
                        alert("Network error: " + shellErr.toString());
                        return null;
                    }

                    if (!responseStr || responseStr === "") {
                        if (attempts <= maxRetries) continue;
                        alert("API returned an empty response.\n\nPossible causes:\n\u2022 No internet connection\n\u2022 Invalid API key\n\u2022 API service is down");
                        return null;
                    }

                    // Parse outer API response
                    var jsonResp;
                    try {
                        jsonResp = JSON.parse(responseStr);
                    } catch (pe) {
                        if (attempts <= maxRetries) continue;
                        alert("API returned invalid JSON.\n\nFirst 300 chars:\n" + responseStr.substr(0, 300));
                        return null;
                    }

                    if (jsonResp.error) {
                        var errMsg = jsonResp.error.message || jsonResp.error.type || JSON.stringify(jsonResp.error);
                        alert("API Error from " + model + ":\n\n" + errMsg);
                        return null;
                    }

                    // Extract text content
                    var rawContent = "";
                    if (modelUsesOpenAIResponseShape(model) && jsonResp.choices && jsonResp.choices.length > 0) {
                        rawContent = jsonResp.choices[0].message.content;
                    } else if (model === "Claude" && jsonResp.content && jsonResp.content.length > 0) {
                        rawContent = jsonResp.content[0].text;
                    } else if (model === "Gemini" && jsonResp.candidates && jsonResp.candidates.length > 0 && jsonResp.candidates[0].content && jsonResp.candidates[0].content.parts && jsonResp.candidates[0].content.parts.length > 0) {
                        rawContent = jsonResp.candidates[0].content.parts[0].text;
                    } else {
                        if (attempts <= maxRetries) continue;
                        alert("Unexpected response format from " + model + ".\n\n" + responseStr.substr(0, 300));
                        return null;
                    }

                    // Step 1 — Extract JSON
                    var aiScript = extractJSON(rawContent);
                    if (!aiScript) {
                        if (attempts <= maxRetries) continue;
                        var eWin = new Window("dialog", "AI Parse Error");
                        eWin.orientation = "column";
                        eWin.add("statictext", undefined, "Could not extract valid JSON from AI response after 3 attempts:");
                        var eText = eWin.add("edittext", undefined, rawContent, { multiline: true, scrolling: true });
                        eText.preferredSize = [450, 250];
                        var eClose = eWin.add("button", undefined, "Close");
                        eClose.onClick = function () { eWin.close(); };
                        eWin.center(); eWin.show();
                        return null;
                    }

                    // Step 2 — Validate required fields (scripts use "script" not "expression")
                    if (!aiScript.name || !aiScript.script || !aiScript.description) {
                        if (attempts <= maxRetries) continue;
                        alert("AI returned JSON but missing required fields.\n\nReceived:\n" + JSON.stringify(aiScript).substr(0, 200));
                        return null;
                    }

                    // Step 3 — Validate syntax
                    if (!validateScriptBool(aiScript.script)) {
                        if (attempts <= maxRetries) continue;
                        alert("AI generated forbidden syntax after 3 attempts. Try rephrasing your request.");
                        return null;
                    }

                    return aiScript;
                }

                return null;
            }

            // Call the AI
            var result = callScriptAI(userInput);
            if (!result) return;

            // --- Preview Dialog ---
            var scPvWin = new Window("palette", "\u2727 AI Generated Script \u2014 Preview");
            scPvWin.orientation = "column";
            scPvWin.alignChildren = ["fill", "top"];
            scPvWin.preferredSize = [480, -1];

            // Name
            var scNGrp = scPvWin.add("group");
            scNGrp.orientation = "row";
            scNGrp.alignment = ["fill", "top"];
            scNGrp.add("statictext", undefined, "Name:");
            var scPvName = scNGrp.add("edittext", undefined, result.name);
            scPvName.alignment = ["fill", "center"];

            // Description
            var scDGrp = scPvWin.add("group");
            scDGrp.orientation = "column";
            scDGrp.alignment = ["fill", "top"];
            scDGrp.alignChildren = ["fill", "top"];
            scDGrp.add("statictext", undefined, "Description:");
            var scPvDesc = scDGrp.add("edittext", undefined, result.description || "");
            scPvDesc.characters = 50;

            // Code
            var scCGrp = scPvWin.add("group");
            scCGrp.orientation = "column";
            scCGrp.alignment = ["fill", "top"];
            scCGrp.alignChildren = ["fill", "top"];
            scCGrp.add("statictext", undefined, "Script Code:");
            var scPvCode = scCGrp.add("edittext", undefined, result.script, { multiline: true, scrolling: true });
            scPvCode.preferredSize = [-1, 200];

            // Buttons
            var scBtnGrp2 = scPvWin.add("group");
            scBtnGrp2.orientation = "row";
            scBtnGrp2.alignment = ["fill", "top"];
            scBtnGrp2.alignChildren = ["fill", "center"];
            var scPvDiscard = scBtnGrp2.add("button", undefined, "\u2715 Discard");
            var scPvRegen = scBtnGrp2.add("button", undefined, "\u21bb Regenerate");
            var scPvRun = buildColBtn(scBtnGrp2, "\u25ba Test Run", colorPurple);
            var scPvSave = scBtnGrp2.add("button", undefined, "\u2713 Save to Library");

            scPvDiscard.onClick = function () { scPvWin.close(); };

            scPvRegen.onClick = function () {
                btnAIScript.updateText("\u23f3 Regenerating...");
                if (win.update) win.update();
                var newResult = callScriptAI(userInput);
                btnAIScript.updateText("\u2727 Auto-Generate Script");
                if (win.update) win.update();
                if (newResult) {
                    scPvName.text = newResult.name;
                    scPvDesc.text = newResult.description || "";
                    scPvCode.text = newResult.script;
                }
            };

            scPvRun.onClick = function () {
                var code = scPvCode.text;
                if (!code || code === "") { alert("No script code to run."); return; }
                if (!confirm("WARNING: Executing scripts grants them full access to After Effects and your computer. Only run scripts you trust. Proceed?")) return;
                if (containsRiskyScriptOps(code) &&
                    !confirm("High-risk operations were detected in this script (file/system/project actions).\nRun anyway?")) return;
                app.beginUndoGroup("AI Script Test Run");
                var tempScript = null;
                try {
                    tempScript = new File(Folder.temp.fullName + "/balongra_temp_run.jsx");
                    tempScript.encoding = "UTF-8";
                    tempScript.open("w");
                    tempScript.write(code);
                    tempScript.close();
                    $.evalFile(tempScript);
                    appendHistory("AI preview script executed: " + (scPvName.text || "AI Script"));
                } catch (e) {
                    appendHistory("AI preview script failed: " + e.toString().substr(0, 90));
                    alert("Script Error:\n" + e.toString());
                } finally {
                    try { if (tempScript && tempScript.exists) tempScript.remove(); } catch (x) { }
                }
                app.endUndoGroup();
            };

            scPvSave.onClick = function () {
                var newScript = {
                    name: scPvName.text || "AI Script",
                    description: scPvDesc.text || "",
                    script: scPvCode.text
                };
                scriptLibrary.push(newScript);
                saveScripts();
                updateScriptList();
                appendHistory("AI script added to library: " + newScript.name);
                scPvWin.close();
                // Select the new entry
                if (scriptList.items.length > 0) {
                    scriptList.selection = scriptList.items.length - 1;
                }
                alert("\u2728 Script saved:\n" + newScript.name);
            };

            scPvWin.center();
            scPvWin.show();
        };


        var toggleScEditBtn = buildColBtn(tabs.script, "⊞ ADD NEW SCRIPT", colorSteel);
        toggleScEditBtn.alignment = ["fill", "bottom"];

        // Add/Edit Script Section
        var scEditGroup = buildGlassPanel(tabs.script, "Script Editor");
        scEditGroup.orientation = "column";
        scEditGroup.alignment = ["fill", "bottom"];
        scEditGroup.alignChildren = ["fill", "top"];
        scEditGroup.margins = 8;
        scEditGroup.visible = false;

        var scNameLbl = scEditGroup.add("statictext", undefined, "Script Name:");
        applyTextStyle(scNameLbl, "label");
        var scNameInput = scEditGroup.add("edittext", undefined, "");
        scNameInput.preferredSize = [-1, 20];
        styleInput(scNameInput, false);

        var scDescLbl = scEditGroup.add("statictext", undefined, "Description (Optional):");
        applyTextStyle(scDescLbl, "label");
        var scDescInput = scEditGroup.add("edittext", undefined, "");
        scDescInput.preferredSize = [-1, 20];
        styleInput(scDescInput, false);

        var scCodeLbl = scEditGroup.add("statictext", undefined, "ExtendScript Code:");
        applyTextStyle(scCodeLbl, "label");
        var scCodeInput = scEditGroup.add("edittext", undefined, "", { multiline: true, scrolling: true });
        scCodeInput.preferredSize = [-1, 80];
        styleInput(scCodeInput, true);

        var scBtnGroup = scEditGroup.add("group");
        scBtnGroup.orientation = "row";
        scBtnGroup.alignment = "fill";
        scBtnGroup.alignChildren = ["fill", "center"];

        var saveScBtn = scBtnGroup.add("button", undefined, "Save");
        var updateScBtn = scBtnGroup.add("button", undefined, "Update");
        var cancelScBtn = scBtnGroup.add("button", undefined, "Cancel");
        updateScBtn.visible = false;

        var isScEditMode = false;
        var editingScIndex = -1;

        // ==========================================
        // TAB 3: TOOLS / AI
        // ==========================================
        tabs.tools = mainContainer.add("group");
        tabs.tools.orientation = "column";
        tabs.tools.alignChildren = ["fill", "top"];
        tabs.tools.alignment = ["fill", "top"];
        tabs.tools.spacing = uiTokens.spacingMD;
        tabs.tools.visible = false;

        // Workflow Tools Section
        var toolsPanel = buildGlassPanel(tabs.tools, "Workflow Automation");
        toolsPanel.orientation = "column";
        toolsPanel.alignChildren = ["fill", "top"];
        toolsPanel.margins = uiTokens.panelMargin;

        var btnBake = toolsPanel.add("button", undefined, "⎈ Bake Expressions to Keyframes");
        var btnError = toolsPanel.add("button", undefined, "⨹ Expression Error Doctor");

        // Note: Expression Builder is now in the Expressions tab.
        var aiMovedPanel = buildGlassPanel(tabs.tools, "Expression Builder");
        aiMovedPanel.orientation = "column";
        aiMovedPanel.alignChildren = ["fill", "top"];
        aiMovedPanel.margins = uiTokens.panelMargin;
        var aiMovedTxt = aiMovedPanel.add("statictext", undefined,
            "Expression generation was moved to Panel 1 for faster build-and-apply workflow.",
            { multiline: true });
        aiMovedTxt.preferredSize = [-1, 24];
        applyTextStyle(aiMovedTxt, "subtle");

        var aiMovedBtnRow = aiMovedPanel.add("group");
        aiMovedBtnRow.orientation = "row";
        aiMovedBtnRow.alignment = ["fill", "top"];
        aiMovedBtnRow.alignChildren = ["fill", "center"];
        aiMovedBtnRow.spacing = uiTokens.spacingSM;
        aiMovedBtnRow.minimumSize = [-1, uiTokens.rowHeight];
        var btnOpenExprBuilder = buildColBtn(aiMovedBtnRow, "OPEN EXPRESSION BUILDER", colorOrange);
        var btnOpenExprTab = buildColBtn(aiMovedBtnRow, "GO TO EXPRESSIONS TAB", colorSteel);

        // API Settings Section
        var apiPanel = buildGlassPanel(tabs.tools, "API Settings");
        apiPanel.orientation = "column";
        apiPanel.alignChildren = ["fill", "top"];
        apiPanel.margins = uiTokens.panelMargin;

        var apiModGroup = apiPanel.add("group");
        apiModGroup.orientation = "row";
        apiModGroup.alignChildren = ["left", "center"];
        apiModGroup.spacing = uiTokens.spacingSM;
        var apiModelLbl = apiModGroup.add("statictext", undefined, "Active Model:");
        applyTextStyle(apiModelLbl, "label");
        var apiDropdown = apiModGroup.add("dropdownlist", undefined, [
            "ChatGPT", "Claude", "Gemini", "Kimi", "OpenRouter", "Groq", "Cerebras", "NVIDIA NIM", "GitHub Models", "Mistral", "Custom Endpoint"
        ]);
        apiDropdown.selection = 0;
        apiDropdown.preferredSize = [180, uiTokens.rowHeight];
        applyTextStyle(apiDropdown, "mono");

        var apiProfileRow = apiPanel.add("group");
        apiProfileRow.orientation = "row";
        apiProfileRow.alignment = ["fill", "top"];
        apiProfileRow.alignChildren = ["left", "center"];
        apiProfileRow.spacing = uiTokens.spacingSM;
        var apiProfileLbl = apiProfileRow.add("statictext", undefined, "Endpoint Profile:");
        applyTextStyle(apiProfileLbl, "label");
        var apiProfileDropdown = apiProfileRow.add("dropdownlist", undefined, ["OpenAI", "Claude", "LM Studio", "Ollama", "Custom"]);
        apiProfileDropdown.selection = 0;
        apiProfileDropdown.preferredSize = [150, uiTokens.rowHeight];
        applyTextStyle(apiProfileDropdown, "mono");
        var btnApplyProfile = buildColBtn(apiProfileRow, "APPLY PROFILE", colorSteel);

        var apiKeyGroup = apiPanel.add("group");
        apiKeyGroup.orientation = "stack";
        apiKeyGroup.alignChildren = ["fill", "top"];
        apiKeyGroup.spacing = 2;

        var grpGpt = apiKeyGroup.add("group");
        grpGpt.orientation = "column"; grpGpt.alignChildren = ["fill", "top"]; grpGpt.spacing = 2;
        var tGpt = grpGpt.add("statictext", undefined, "OpenAI API Key:");
        var apiGptInput = grpGpt.add("edittext", undefined, "", { password: true });
        applyTextStyle(tGpt, "label");
        styleInput(apiGptInput, true);

        var grpClaude = apiKeyGroup.add("group");
        grpClaude.orientation = "column"; grpClaude.alignChildren = ["fill", "top"]; grpClaude.spacing = 2;
        var tClaude = grpClaude.add("statictext", undefined, "Anthropic API Key:");
        var apiClaudeInput = grpClaude.add("edittext", undefined, "", { password: true });
        applyTextStyle(tClaude, "label");
        styleInput(apiClaudeInput, true);

        var grpGemini = apiKeyGroup.add("group");
        grpGemini.orientation = "column"; grpGemini.alignChildren = ["fill", "top"]; grpGemini.spacing = 2;
        var tGem = grpGemini.add("statictext", undefined, "Google Gemini API Key:");
        var apiGeminiInput = grpGemini.add("edittext", undefined, "", { password: true });
        applyTextStyle(tGem, "label");
        styleInput(apiGeminiInput, true);

        var grpKimi = apiKeyGroup.add("group");
        grpKimi.orientation = "column"; grpKimi.alignChildren = ["fill", "top"]; grpKimi.spacing = 2;
        var tKimi = grpKimi.add("statictext", undefined, "Kimi (Moonshot) API Key:");
        var apiKimiInput = grpKimi.add("edittext", undefined, "", { password: true });
        applyTextStyle(tKimi, "label");
        styleInput(apiKimiInput, true);

        var grpOpRouter = apiKeyGroup.add("group");
        grpOpRouter.orientation = "column"; grpOpRouter.alignChildren = ["fill", "top"]; grpOpRouter.spacing = 2;
        var tOpRouter = grpOpRouter.add("statictext", undefined, "OpenRouter API Key:");
        var apiOpRouterInput = grpOpRouter.add("edittext", undefined, "", { password: true });
        applyTextStyle(tOpRouter, "label");
        styleInput(apiOpRouterInput, true);

        var grpGroq = apiKeyGroup.add("group");
        grpGroq.orientation = "column"; grpGroq.alignChildren = ["fill", "top"]; grpGroq.spacing = 2;
        var tGroq = grpGroq.add("statictext", undefined, "Groq API Key:");
        var apiGroqInput = grpGroq.add("edittext", undefined, "", { password: true });
        applyTextStyle(tGroq, "label");
        styleInput(apiGroqInput, true);

        var grpCerebras = apiKeyGroup.add("group");
        grpCerebras.orientation = "column"; grpCerebras.alignChildren = ["fill", "top"]; grpCerebras.spacing = 2;
        var tCerebras = grpCerebras.add("statictext", undefined, "Cerebras API Key:");
        var apiCerebrasInput = grpCerebras.add("edittext", undefined, "", { password: true });
        applyTextStyle(tCerebras, "label");
        styleInput(apiCerebrasInput, true);

        var grpNim = apiKeyGroup.add("group");
        grpNim.orientation = "column"; grpNim.alignChildren = ["fill", "top"]; grpNim.spacing = 2;
        var tNim = grpNim.add("statictext", undefined, "NVIDIA NIM API Key:");
        var apiNimInput = grpNim.add("edittext", undefined, "", { password: true });
        applyTextStyle(tNim, "label");
        styleInput(apiNimInput, true);

        var grpGithub = apiKeyGroup.add("group");
        grpGithub.orientation = "column"; grpGithub.alignChildren = ["fill", "top"]; grpGithub.spacing = 2;
        var tGithub = grpGithub.add("statictext", undefined, "GitHub Models Token:");
        var apiGithubInput = grpGithub.add("edittext", undefined, "", { password: true });
        applyTextStyle(tGithub, "label");
        styleInput(apiGithubInput, true);

        var grpMistral = apiKeyGroup.add("group");
        grpMistral.orientation = "column"; grpMistral.alignChildren = ["fill", "top"]; grpMistral.spacing = 2;
        var tMistral = grpMistral.add("statictext", undefined, "Mistral API Key:");
        var apiMistralInput = grpMistral.add("edittext", undefined, "", { password: true });
        applyTextStyle(tMistral, "label");
        styleInput(apiMistralInput, true);

        var grpCustom = apiKeyGroup.add("group");
        grpCustom.orientation = "column"; grpCustom.alignChildren = ["fill", "top"]; grpCustom.spacing = 2;
        var tCustomUrl = grpCustom.add("statictext", undefined, "Custom API Endpoint URL:");
        var apiCustomUrlInput = grpCustom.add("edittext", undefined, apiSettings.customEndpointUrl || "");
        var tCustomModel = grpCustom.add("statictext", undefined, "Custom Model ID:");
        var apiCustomModelInput = grpCustom.add("edittext", undefined, apiSettings.customModel || "local-model");
        var tCustomKey = grpCustom.add("statictext", undefined, "Custom API Key (optional):");
        var apiCustomKeyInput = grpCustom.add("edittext", undefined, "", { password: true });
        applyTextStyle(tCustomUrl, "label");
        applyTextStyle(tCustomModel, "label");
        applyTextStyle(tCustomKey, "label");
        styleInput(apiCustomUrlInput, true);
        styleInput(apiCustomModelInput, true);
        styleInput(apiCustomKeyInput, true);

        function updateApiVisibility() {
            var sel = apiDropdown.selection ? apiDropdown.selection.text : "ChatGPT";

            grpGpt.visible = (sel === "ChatGPT");
            grpClaude.visible = (sel === "Claude");
            grpGemini.visible = (sel === "Gemini");
            grpKimi.visible = (sel === "Kimi");
            grpOpRouter.visible = (sel === "OpenRouter");
            grpGroq.visible = (sel === "Groq");
            grpCerebras.visible = (sel === "Cerebras");
            grpNim.visible = (sel === "NVIDIA NIM");
            grpGithub.visible = (sel === "GitHub Models");
            grpMistral.visible = (sel === "Mistral");
            grpCustom.visible = (sel === "Custom Endpoint");

            win.layout.layout(true);
        }
        function setApiStatus(statusText) {
            if (apiStatusBadge) apiStatusBadge.text = "Status: " + statusText;
            if (win.update) win.update();
        }

        apiDropdown.onChange = function () {
            uiState.selectedModel = apiDropdown.selection ? apiDropdown.selection.text : "ChatGPT";
            updateApiVisibility();
            if (agentModelDisplay) agentModelDisplay.text = uiState.selectedModel;
        };

        btnApplyProfile.onClick = function () {
            var p = apiProfileDropdown.selection ? apiProfileDropdown.selection.text : "OpenAI";
            if (p === "OpenAI") {
                apiDropdown.selection = 0;
            } else if (p === "Claude") {
                apiDropdown.selection = 1;
            } else if (p === "LM Studio") {
                apiDropdown.selection = 10;
                apiCustomUrlInput.text = "http://localhost:1234/v1/chat/completions";
                if (!apiCustomModelInput.text) apiCustomModelInput.text = "lmstudio-community";
            } else if (p === "Ollama") {
                apiDropdown.selection = 10;
                apiCustomUrlInput.text = "http://localhost:11434/v1/chat/completions";
                if (!apiCustomModelInput.text) apiCustomModelInput.text = "llama3.1:8b";
            } else {
                apiDropdown.selection = 10;
            }
            apiSettings.activeModel = apiDropdown.selection ? apiDropdown.selection.text : "Custom Endpoint";
            uiState.selectedModel = apiSettings.activeModel;
            updateApiVisibility();
            setApiStatus("Profile " + p + " ready");
            appendHistory("Endpoint profile applied: " + p + " -> " + apiSettings.activeModel);
            saveExpressions();
        };

        function pickApiValue(savedValue, inputValue, preferSaved) {
            return preferSaved ? (savedValue || inputValue) : (inputValue || savedValue);
        }

        function resolveModelConnection(model, preferSaved) {
            var conn = { apiKey: "", apiUrl: "", keyRequired: modelRequiresApiKey(model) };

            if (model === "ChatGPT") {
                conn.apiKey = pickApiValue(apiSettings.openAIKey, apiGptInput.text, preferSaved);
                conn.apiUrl = "https://api.openai.com/v1/chat/completions";
            } else if (model === "Claude") {
                conn.apiKey = pickApiValue(apiSettings.anthropicKey, apiClaudeInput.text, preferSaved);
                conn.apiUrl = "https://api.anthropic.com/v1/messages";
            } else if (model === "Gemini") {
                conn.apiKey = pickApiValue(apiSettings.geminiKey, apiGeminiInput.text, preferSaved);
                conn.apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=";
            } else if (model === "Kimi") {
                conn.apiKey = pickApiValue(apiSettings.kimiKey, apiKimiInput.text, preferSaved);
                conn.apiUrl = "https://api.moonshot.cn/v1/chat/completions";
            } else if (model === "OpenRouter") {
                conn.apiKey = pickApiValue(apiSettings.openRouterKey, apiOpRouterInput.text, preferSaved);
                conn.apiUrl = "https://openrouter.ai/api/v1/chat/completions";
            } else if (model === "Groq") {
                conn.apiKey = pickApiValue(apiSettings.groqKey, apiGroqInput.text, preferSaved);
                conn.apiUrl = "https://api.groq.com/openai/v1/chat/completions";
            } else if (model === "Cerebras") {
                conn.apiKey = pickApiValue(apiSettings.cerebrasKey, apiCerebrasInput.text, preferSaved);
                conn.apiUrl = "https://api.cerebras.ai/v1/chat/completions";
            } else if (model === "NVIDIA NIM") {
                conn.apiKey = pickApiValue(apiSettings.nimKey, apiNimInput.text, preferSaved);
                conn.apiUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
            } else if (model === "GitHub Models") {
                conn.apiKey = pickApiValue(apiSettings.githubKey, apiGithubInput.text, preferSaved);
                conn.apiUrl = "https://models.inference.ai.azure.com/chat/completions";
            } else if (model === "Mistral") {
                conn.apiKey = pickApiValue(apiSettings.mistralKey, apiMistralInput.text, preferSaved);
                conn.apiUrl = "https://api.mistral.ai/v1/chat/completions";
            } else if (model === "Custom Endpoint") {
                conn.apiKey = pickApiValue(apiSettings.customApiKey, apiCustomKeyInput.text, preferSaved);
                conn.apiUrl = pickApiValue(apiSettings.customEndpointUrl, apiCustomUrlInput.text, preferSaved);
                apiSettings.customModel = pickApiValue(apiSettings.customModel, apiCustomModelInput.text, preferSaved) || "local-model";
            }

            if (model === "Gemini" && conn.apiUrl && conn.apiUrl.indexOf("?key=") !== -1) {
                // Legacy: strip key from URL — it is now passed as x-goog-api-key header instead
                conn.apiUrl = conn.apiUrl.substring(0, conn.apiUrl.indexOf("?key="));
            }
            if (model === "Gemini" && conn.apiUrl && conn.apiUrl.charAt(conn.apiUrl.length - 1) === "=") {
                // Legacy format where URL ended with "?key=": strip the dangling suffix
                conn.apiUrl = conn.apiUrl.substring(0, conn.apiUrl.length - 5); // remove "?key="
            }

            return conn;
        }

        var apiBtnRow = apiPanel.add("group");
        apiBtnRow.orientation = "row";
        apiBtnRow.alignment = ["fill", "top"];
        apiBtnRow.alignChildren = ["fill", "center"];
        apiBtnRow.spacing = uiTokens.spacingSM;
        apiBtnRow.minimumSize = [-1, uiTokens.rowHeight];
        var btnSaveApi = buildColBtn(apiBtnRow, "SAVE API KEYS", colorSteel);
        var btnTestApi = buildColBtn(apiBtnRow, "TEST CONNECTION", colorOrange);
        var apiStatusBadge = apiBtnRow.add("statictext", undefined, "Status: Idle");
        applyTextStyle(apiStatusBadge, "subtle");
        apiStatusBadge.alignment = ["right", "center"];

        // Library Management Section
        var libPanel = buildGlassPanel(tabs.tools, "Library Management");
        libPanel.orientation = "row";
        libPanel.alignChildren = ["fill", "center"];
        libPanel.margins = uiTokens.panelMargin;

        var btnExportLib = libPanel.add("button", undefined, "⍗ Export Library");
        var btnImportLib = libPanel.add("button", undefined, "⍐ Import Library");
        var btnResetLib = libPanel.add("button", undefined, "↺ Reset Defaults");

        // Action History
        var historyPanel = buildGlassPanel(tabs.tools, "Action History");
        historyPanel.orientation = "column";
        historyPanel.alignChildren = ["fill", "fill"];
        historyPanel.alignment = ["fill", "fill"];
        historyPanel.margins = uiTokens.panelMargin;

        var historyOutput = historyPanel.add("edittext", undefined, "No actions yet.\n", { multiline: true, scrolling: true, readonly: true });
        historyOutput.preferredSize = [-1, 120];
        historyOutput.alignment = ["fill", "fill"];
        styleInput(historyOutput, true);

        var historyRow = historyPanel.add("group");
        historyRow.orientation = "row";
        historyRow.alignment = ["fill", "bottom"];
        historyRow.alignChildren = ["fill", "center"];
        historyRow.spacing = uiTokens.spacingSM;
        var btnHistoryClear = buildColBtn(historyRow, "CLEAR HISTORY", colorSteel);
        var btnHistoryCopy = buildColBtn(historyRow, "COPY HISTORY", colorSteel);

        function appendHistory(message) {
            var ts = new Date();
            var stamp = "[" + ts.getHours() + ":" + ("0" + ts.getMinutes()).slice(-2) + ":" + ("0" + ts.getSeconds()).slice(-2) + "]";
            var line = stamp + " " + message;
            actionHistory.push(line);
            if (actionHistory.length > 200) actionHistory.shift();
            historyOutput.text = actionHistory.join("\n") + "\n";
            appendRuntimeLog("HISTORY", message || "");
            if (win.update) win.update();
        }

        btnHistoryClear.onClick = function () {
            actionHistory = [];
            historyOutput.text = "No actions yet.\n";
        };

        btnHistoryCopy.onClick = function () {
            if (!actionHistory || actionHistory.length === 0) {
                alert("History is empty.");
                return;
            }
            var text = actionHistory.join("\n");
            try {
                var isMac = ($.os.indexOf("Mac") !== -1);
                if (isMac) {
                    var escaped = text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\$/g, "\\$");
                    system.callSystem('printf "%s" "' + escaped + '" | pbcopy');
                } else {
                    var tFile = new File(Folder.temp.fullName + "/balongra_history_copy.txt");
                    try {
                        tFile.encoding = "UTF-8";
                        if (!tFile.open("w")) throw new Error("Could not open temp clipboard file.");
                        tFile.write(text);
                        tFile.close();
                        system.callSystem('type "' + tFile.fsName + '" | clip');
                    } finally {
                        try { if (tFile && tFile.exists) tFile.remove(); } catch (z) { }
                    }
                }
                alert("History copied to clipboard.");
            } catch (e) {
                alert("Could not copy history automatically.\n\n" + text.substr(0, 600));
            }
        };

        // ==========================================
        // TAB 4: AGENT
        // ==========================================
        tabs.agent = mainContainer.add("group");
        tabs.agent.orientation = "column";
        tabs.agent.alignChildren = ["fill", "fill"];
        tabs.agent.alignment = ["fill", "fill"];
        tabs.agent.spacing = uiTokens.spacingSM;
        tabs.agent.visible = false;

        // --- Prompt Panel ---
        var agentPromptPanel = buildGlassPanel(tabs.agent, "Composition Agent");
        agentPromptPanel.orientation = "column";
        agentPromptPanel.alignChildren = ["fill", "top"];
        agentPromptPanel.alignment = ["fill", "top"];
        agentPromptPanel.margins = uiTokens.panelMargin;

        var agentInfoText = agentPromptPanel.add("statictext", undefined,
            "Describe what to build. The agent makes one plan and executes it. Use Father's Money Mode for maximum quality with a capable model.",
            { multiline: true });
        agentInfoText.preferredSize = [-1, 32]; // force wrap in ScriptUI
        agentInfoText.alignment = ["fill", "top"];
        agentInfoText.graphics.foregroundColor = agentInfoText.graphics.newPen(
            agentInfoText.graphics.PenType.SOLID_COLOR, [0.55, 0.55, 0.55], 1);

        // Mode badge row — shows mode + active skills + model tier
        var agentModeRow = agentPromptPanel.add("group");
        agentModeRow.orientation = "row";
        agentModeRow.alignment = ["fill", "top"];
        agentModeRow.alignChildren = ["left", "center"];
        agentModeRow.spacing = 8;
        agentModeRow.preferredSize = [-1, 18];

        var agentModeBadge = agentModeRow.add("statictext", undefined, "");
        agentModeBadge.preferredSize = [210, -1];
        agentModeBadge.graphics.foregroundColor = agentModeBadge.graphics.newPen(
            agentModeBadge.graphics.PenType.SOLID_COLOR, [0.95, 0.75, 0.2], 1);

        var agentSkillBadge = agentModeRow.add("statictext", undefined, "");
        agentSkillBadge.alignment = ["fill", "center"];
        agentSkillBadge.graphics.foregroundColor = agentSkillBadge.graphics.newPen(
            agentSkillBadge.graphics.PenType.SOLID_COLOR, [0.4, 0.82, 0.98], 1);

        var agentTierBadge = agentModeRow.add("statictext", undefined, "");
        agentTierBadge.graphics.foregroundColor = agentTierBadge.graphics.newPen(
            agentTierBadge.graphics.PenType.SOLID_COLOR, [0.72, 0.92, 0.62], 1);

        var agentControlPanel = buildGlassPanel(agentPromptPanel, "Agent Controls");
        agentControlPanel.orientation = "column";
        agentControlPanel.alignChildren = ["fill", "top"];
        agentControlPanel.alignment = ["fill", "top"];
        agentControlPanel.margins = uiTokens.panelMargin;

        var agentControlRow1 = agentControlPanel.add("group");
        agentControlRow1.orientation = "row";
        agentControlRow1.alignChildren = ["left", "center"];
        agentControlRow1.alignment = ["fill", "top"];
        agentControlRow1.spacing = 10;

        var cbAgentPreviewPlan = agentControlRow1.add("checkbox", undefined, "Show plan preview");
        cbAgentPreviewPlan.value = (uiState.agentPlanPreviewEnabled !== false);
        var cbAgentPersistentLog = agentControlRow1.add("checkbox", undefined, "Persistent runtime log");
        cbAgentPersistentLog.value = (uiState.agentPersistentLoggingEnabled !== false);

        var agentControlRow2 = agentControlPanel.add("group");
        agentControlRow2.orientation = "row";
        agentControlRow2.alignChildren = ["left", "center"];
        agentControlRow2.alignment = ["fill", "top"];
        agentControlRow2.spacing = 8;

        var cbFatherMoneyMode = agentControlRow2.add("checkbox", undefined, "💰 Father's Money Mode");
        cbFatherMoneyMode.value = (uiState.agentFathersMoneyModeEnabled === true);
        var fmmDesc = agentControlRow2.add("statictext", undefined, "— full skills + high token budget");
        fmmDesc.graphics.foregroundColor = fmmDesc.graphics.newPen(
            fmmDesc.graphics.PenType.SOLID_COLOR, [0.5, 0.5, 0.5], 1);

        // Skill toggles removed — all skills always active.
        // Father's Money Mode controls depth (full guide vs. lean constraints).
        var agentSkillToggleRefs = []; // kept for compatibility, unused

        cbAgentPreviewPlan.onClick = function () {
            uiState.agentPlanPreviewEnabled = cbAgentPreviewPlan.value;
            saveExpressions();
        };
        cbAgentPersistentLog.onClick = function () {
            uiState.agentPersistentLoggingEnabled = cbAgentPersistentLog.value;
            saveExpressions();
        };
        cbFatherMoneyMode.onClick = function () {
            if (cbFatherMoneyMode.value) {
                alert("Father's Money Mode\n\n" +
                    "This mode sends the FULL skill guide to the model and raises the token budget significantly.\n\n" +
                    "IMPORTANT: Only use this with a capable model (GPT-4o, Claude Sonnet/Opus, Mistral Large, etc.).\n" +
                    "Flash/mini/small models will still underperform — the prompt is bigger but they can't follow it.\n\n" +
                    "If your API key is on a free or rate-limited tier, this will burn through it faster.");
            }
            uiState.agentFathersMoneyModeEnabled = cbFatherMoneyMode.value;
            saveExpressions();
            refreshAgentLiveAnalysis();
        };

        var agentPromptInput = agentPromptPanel.add("edittext", undefined, "", { multiline: true, scrolling: true });
        agentPromptInput.preferredSize = [-1, 72];
        agentPromptInput.helpTip = "Describe the task. Skills and mode are inferred automatically; Father's Money Mode forces maximum depth.";
        styleInput(agentPromptInput, true);

        var _lastAnalysis = null;
        function refreshAgentBadges(analysis) {
            if (!analysis) {
                agentModeBadge.text = "";
                agentSkillBadge.text = "";
                agentTierBadge.text = "";
                if (win.update) win.update();
                return;
            }
            if (analysis.isFathersMoneyMode) agentModeBadge.text = "[FATHER'S MONEY MODE]";
            else if (analysis.isGoldMode) agentModeBadge.text = "[GOLD MODE]";
            else if (analysis.isHardMode) agentModeBadge.text = "[HARD MODE]";
            else agentModeBadge.text = "[Normal]";
            agentSkillBadge.text = buildAgentSkillBadgeText(analysis.skills, true);
            agentTierBadge.text = "Tier: " + (analysis.modelTier || "small").toUpperCase();
            if (win.update) win.update();
        }

        function refreshAgentLiveAnalysis() {
            var txt = agentPromptInput.text || "";
            if (txt.length < 3) {
                _lastAnalysis = null;
                refreshAgentBadges(null);
                return;
            }
            _lastAnalysis = analyzePrompt(txt);
            refreshAgentBadges(_lastAnalysis);
        }

        agentPromptInput.onChanging = function () {
            refreshAgentLiveAnalysis();
        };

        var agentBtnRow = agentPromptPanel.add("group");
        agentBtnRow.orientation = "row";
        agentBtnRow.alignment = ["fill", "top"];
        agentBtnRow.alignChildren = ["fill", "center"];
        agentBtnRow.spacing = uiTokens.spacingSM;
        agentBtnRow.minimumSize = [-1, uiTokens.rowHeight];

        var agentModelLabel = agentBtnRow.add("statictext", undefined, "Model:");
        agentModelLabel.graphics.foregroundColor = agentModelLabel.graphics.newPen(
            agentModelLabel.graphics.PenType.SOLID_COLOR, [0.6, 0.6, 0.6], 1);
        var agentModelDisplay = agentBtnRow.add("statictext", undefined, apiSettings.activeModel || "ChatGPT");
        agentModelDisplay.graphics.foregroundColor = agentModelDisplay.graphics.newPen(
            agentModelDisplay.graphics.PenType.SOLID_COLOR, [0.9, 0.9, 0.9], 1);

        var agentRunBtn = buildColBtn(agentBtnRow, "\u2bc1 Run Agent", colorOrange);
        agentRunBtn.alignment = ["fill", "center"];

        // --- Log Panel ---
        var agentLogPanel = buildGlassPanel(tabs.agent, "Execution Log");
        agentLogPanel.orientation = "column";
        agentLogPanel.alignChildren = ["fill", "fill"];
        agentLogPanel.alignment = ["fill", "fill"];
        agentLogPanel.margins = uiTokens.panelMargin;

        var agentLogOutput = agentLogPanel.add("edittext", undefined, "Ready. Enter a prompt and click Run Agent.\n", {
            multiline: true, scrolling: true, readonly: true
        });
        agentLogOutput.alignment = ["fill", "fill"];
        agentLogOutput.preferredSize = [-1, 180];
        styleInput(agentLogOutput, true);
        agentLogOutput.graphics.foregroundColor = agentLogOutput.graphics.newPen(
            agentLogOutput.graphics.PenType.SOLID_COLOR, [0.75, 0.95, 0.75], 1);

        var agentLogActions = agentLogPanel.add("group");
        agentLogActions.orientation = "row";
        agentLogActions.alignment = ["fill", "bottom"];
        agentLogActions.alignChildren = ["fill", "center"];
        agentLogActions.minimumSize = [-1, uiTokens.rowHeight];

        var agentClearBtn = agentLogActions.add("button", undefined, "Clear Log");
        agentClearBtn.alignment = ["left", "center"];
        var agentUndoBtn = agentLogActions.add("button", undefined, "\u21ba Undo Last Run");
        agentUndoBtn.alignment = ["center", "center"];
        var agentRepairBtn = agentLogActions.add("button", undefined, "🔧 Repair");
        agentRepairBtn.alignment = ["right", "center"];
        agentRepairBtn.helpTip = "Run a repair pass on the last run's failed steps. Uses API — only click if you want another API call.";
        agentRepairBtn.enabled = false;

        agentClearBtn.onClick = function () {
            agentLogOutput.text = "";
        };

        agentUndoBtn.onClick = function () {
            try { app.executeCommand(16); } catch (e) { }
        };

        agentRepairBtn.onClick = function () {
            alert("Run a prompt first, then use Repair to fix any failed steps.");
        };

        // --- Agent Run Handler ---
        agentRunBtn.onClick = function () {
            try {
            var prompt = agentPromptInput.text;
            if (!prompt || prompt === "") {
                alert("Please describe what you want the agent to build.");
                return;
            }

            // ── Legacy expression engine warning (from Wiggle_Rig.jsx pattern) ─
            // The Agent writes JavaScript expressions. If the project uses the
            // legacy ExtendScript engine, every expression it applies will error.
            try {
                if (app.project && app.project.expressionEngine === "extendscript") {
                    var engineWarn = "⚠️ Legacy Expression Engine Detected\n\n" +
                        "Your project is set to use the Legacy ExtendScript expressions engine.\n" +
                        "The Agent writes JavaScript expressions, which will fail with this setting.\n\n" +
                        "To fix:\n" +
                        "  1. Click the rocket icon at the bottom of the Project panel\n" +
                        "  2. Switch to the \"Expressions\" tab\n" +
                        "  3. Select \"JavaScript\"\n" +
                        "  4. Click OK\n\n" +
                        "Continue anyway (expressions may error)?";
                    if (!confirm(engineWarn)) return;
                }
            } catch (engErr) {}

            appendHistory("Agent run requested: " + prompt.substr(0, 90));

            var analysis = analyzePrompt(prompt);
            _lastAnalysis = analysis;
            refreshAgentBadges(analysis);

            var lowerPrompt = prompt.toLowerCase();
            var beyondScope = [];
            if (lowerPrompt.indexOf("render queue") !== -1 || lowerPrompt.indexOf("export") !== -1 || lowerPrompt.indexOf("render out") !== -1) {
                beyondScope.push("Render queue / export (use AE Render Queue manually)");
            }
            if (lowerPrompt.indexOf("adobe media encoder") !== -1 || lowerPrompt.indexOf(" ame ") !== -1) {
                beyondScope.push("Adobe Media Encoder (cannot be controlled from Agent)");
            }
            if (lowerPrompt.indexOf("premiere") !== -1 || (lowerPrompt.indexOf("after effects project") !== -1 && lowerPrompt.indexOf("open") !== -1)) {
                beyondScope.push("Opening/switching projects (use File menu manually)");
            }
            if (lowerPrompt.indexOf("download") !== -1 || lowerPrompt.indexOf("internet") !== -1 || lowerPrompt.indexOf("fetch") !== -1) {
                beyondScope.push("Internet / file download (no network access from Agent)");
            }
            if (beyondScope.length > 0) {
                var warnMsg = "Warning: This request includes tasks the Agent cannot perform:\n\n";
                for (var bsi = 0; bsi < beyondScope.length; bsi++) {
                    warnMsg += "  • " + beyondScope[bsi] + "\n";
                }
                warnMsg += "\nThese parts will be skipped. Continue with the rest of the request?";
                if (!confirm(warnMsg)) return;
            }

            var model = apiSettings.activeModel || "ChatGPT";
            agentModelDisplay.text = model;

            var conn = resolveModelConnection(model, true);
            var apiKey = conn.apiKey;
            var apiUrl = conn.apiUrl;

            if (conn.keyRequired && (!apiKey || apiKey === "")) {
                alert("No API key set for " + model + ".\n\nGo to the Tools / AI tab, enter your key, and click Save API Keys.");
                return;
            }
            if (!apiUrl || apiUrl === "") {
                alert("No API endpoint configured for " + model + ".\n\nSet it in Tools / API Settings.");
                return;
            }

            var _lastAgentLogFlushTs = 0;
            function agentAppendLog(line, forceFlush) {
                agentLogOutput.text = agentLogOutput.text + line + "\n";
                appendRuntimeLog("AGENT", line);
                if (agentLogOutput.text.length > 120000) {
                    agentLogOutput.text = agentLogOutput.text.substring(agentLogOutput.text.length - 100000);
                }
                var nowTs = (new Date()).getTime();
                if (forceFlush || (nowTs - _lastAgentLogFlushTs) > 120) {
                    _lastAgentLogFlushTs = nowTs;
                    if (win.update) win.update();
                }
            }

            var runId = "AG-" + (new Date().getTime()) + "-" + Math.floor(Math.random() * 10000);

            function runToolCalls(callList, context, labelPrefix) {
                var summary = {
                    successCount: 0,
                    failCount: 0,
                    failedSteps: [],
                    failedCalls: [],
                    stepRecords: [],
                    recoveredCount: 0,
                    verificationFailCount: 0,
                    repairAttemptCount: 0,
                    stoppedEarly: false
                };
                var consecutiveFails = 0;
                var consecutiveFailLimit = analysis.isFathersMoneyMode ? 6 : (analysis.isGoldMode ? 5 : (analysis.isHardMode ? 4 : 3));
                for (var ci = 0; ci < callList.length; ci++) {
                    var rawCall = callList[ci] || {};
                    var rawArgs = rawCall.args || rawCall.parameters || rawCall.input || {};
                    var tNameRaw = rawCall.tool || rawCall.name || "?";
                    var tName = canonicalizeAgentToolName(tNameRaw) || tNameRaw;
                    var call = { tool: tName, args: agentCloneCallArgs(rawArgs) };
                    var preflight = agentPreflightRepairCall(call.tool, call.args, analysis, null, ci);
                    if (!preflight.ok) {
                        // "skip" means a deliberate silent no-op (e.g. empty setLayerProperties).
                        // Log it quietly but do NOT count it as a failure or increment consecutiveFails.
                        if (preflight.fatal === "skip") {
                            agentAppendLog("  [" + labelPrefix + " " + (ci + 1) + "/" + callList.length + "] " + call.tool + " \u23ed skipped (no-op)");
                            continue;
                        }
                        var preMsg = "Step " + (ci + 1) + " " + call.tool + ": preflight rejected (" + preflight.fatal + ")";
                        agentAppendLog("  [" + labelPrefix + " " + (ci + 1) + "/" + callList.length + "] " + call.tool + "...");
                        agentAppendLog("      \u2715 " + preMsg);
                        summary.failCount++;
                        summary.failedSteps.push(preMsg);
                        summary.failedCalls.push({ tool: call.tool, args: call.args });
                        consecutiveFails++;
                        continue;
                    }
                    call.tool = preflight.tool;
                    call.args = preflight.args;
                    tName = call.tool;

                    var argsHash = agentHashArgs(call.args);
                    var stepRecord = {
                        runId: runId,
                        phase: labelPrefix,
                        step: ci + 1,
                        total: callList.length,
                        tool: tName,
                        argsHash: argsHash,
                        args: call.args,
                        ok: false,
                        recovered: false,
                        verification: "",
                        message: "",
                        recoveryReason: ""
                    };
                    agentAppendLog("  [" + labelPrefix + " " + (ci + 1) + "/" + callList.length + "] " + tName + "...");
                    var riskyReason = getRiskyAgentStepReason(call);
                    if (riskyReason !== "") {
                        var proceedRisk = confirm("Risk check\n\nStep " + (ci + 1) + "/" + callList.length + ": " + tName + "\nReason: " + riskyReason + "\n\nRun this step?");
                        if (!proceedRisk) {
                            agentAppendLog("      \u26a0 Skipped by user (risk confirmation declined).");
                            summary.failCount++;
                            summary.failedSteps.push("Step " + (ci + 1) + " " + tName + " skipped");
                            summary.failedCalls.push({ tool: call.tool, args: call.args });
                            stepRecord.message = "Skipped by user (risk confirmation declined).";
                            summary.stepRecords.push(stepRecord);
                            try { appendRuntimeLog("AGENT_STEP_JSON", JSON.stringify(stepRecord)); } catch (riskLogErr) { }
                            continue;
                        }
                    }

                    var result = dispatchAgentTool(call, context);
                    var finalOk = !!result.ok;
                    var finalMsg = result.msg || "";
                    if (finalOk) {
                        var verify = agentVerifyToolOutcome(call, context);
                        stepRecord.verification = verify.msg || "";
                        if (!verify.ok) {
                            finalOk = false;
                            finalMsg = "Post-check failed: " + verify.msg;
                            summary.verificationFailCount++;
                            agentAppendLog("      \u26a0 " + finalMsg);
                        }
                    }

                    if (!finalOk) {
                        var failure = agentClassifyFailure(finalMsg, call);
                        var recoveries = agentBuildRecoveryCalls(call, failure, context, analysis);
                        if (recoveries && recoveries.length > 0) {
                            var recovered = false;
                            for (var ri = 0; ri < recoveries.length; ri++) {
                                var recCall = recoveries[ri];
                                summary.repairAttemptCount++;
                                agentAppendLog("      \u21ba Recovery " + (ri + 1) + "/" + recoveries.length + ": " + recCall.tool + " (" + (recCall._recoveryReason || "auto") + ")");
                                var recRes = dispatchAgentTool(recCall, context);
                                if (!recRes.ok) {
                                    agentAppendLog("         \u2715 " + recRes.msg);
                                    continue;
                                }
                                var recVerify = agentVerifyToolOutcome(recCall, context);
                                if (!recVerify.ok) {
                                    summary.verificationFailCount++;
                                    agentAppendLog("         \u2715 Recovery post-check failed: " + recVerify.msg);
                                    continue;
                                }
                                recovered = true;
                                finalOk = true;
                                finalMsg = "Recovered via " + recCall.tool + ": " + recRes.msg;
                                stepRecord.recovered = true;
                                stepRecord.recoveryReason = recCall._recoveryReason || "";
                                summary.recoveredCount++;
                                break;
                            }
                            if (!recovered) {
                                finalOk = false;
                            }
                        }
                    }

                    stepRecord.ok = finalOk;
                    stepRecord.message = finalMsg;
                    summary.stepRecords.push(stepRecord);
                    try { appendRuntimeLog("AGENT_STEP_JSON", JSON.stringify(stepRecord)); } catch (stepLogErr) { }

                    if (finalOk) {
                        agentAppendLog("      \u2713 " + finalMsg);
                        summary.successCount++;
                        consecutiveFails = 0;
                    } else {
                        agentAppendLog("      \u2715 " + finalMsg);
                        summary.failCount++;
                        summary.failedSteps.push("Step " + (ci + 1) + " " + tName + ": " + finalMsg);
                        summary.failedCalls.push({ tool: call.tool, args: call.args });
                        consecutiveFails++;

                        if (analysis.isHardMode || analysis.isGoldMode || analysis.isFathersMoneyMode) {
                            var failSnap = agentTool_getCompInfo({ compName: null }, context);
                            if (failSnap && failSnap.ok) {
                                context.lastCompSnapshot = shortPreview(failSnap.msg, 1100);
                                agentAppendLog("      \u21ba Snapshot: " + shortPreview(failSnap.msg, 230));
                            }
                        }

                        if (consecutiveFails >= consecutiveFailLimit) {
                            var remaining = callList.length - (ci + 1);
                            summary.stoppedEarly = true;
                            // Track skipped steps separately — do NOT add them to failCount.
                            // Unexecuted calls are not failures; counting them as such inflates
                            // the failure total, skews the quality score, and makes the run
                            // summary misleading ("10 failed" when only 3 actually ran and failed).
                            if (!summary.skippedCount) summary.skippedCount = 0;
                            summary.skippedCount += remaining;
                            var cbMsg = "Circuit breaker halted after " + consecutiveFails +
                                " consecutive failures" + (remaining > 0 ? "; " + remaining + " step(s) not attempted." : ".");
                            summary.failedSteps.push(cbMsg);
                            agentAppendLog("      \u26a0 " + cbMsg);
                            break;
                        }
                    }
                }
                return summary;
            }

            agentLogOutput.text = "";
            agentAppendLog("\u25ba Prompt: " + prompt);
            agentAppendLog("  Run ID: " + runId);
            if (analysis.isFathersMoneyMode) agentAppendLog("  \ud83d\udcb8 Father's Money Mode active (max depth, est. " + analysis.estimatedToolCalls + " calls)");
            else if (analysis.isGoldMode) agentAppendLog("  \ud83e\udd47 Gold Mode activated (complexity: " + analysis.complexityScore + ", est. " + analysis.estimatedToolCalls + " calls)");
            else if (analysis.isHardMode) agentAppendLog("  \u26a1 Hard Mode activated (complexity: " + analysis.complexityScore + ", est. " + analysis.estimatedToolCalls + " calls)");
            if (analysis.skills.length > 0) {
                agentAppendLog("  Skills loaded: " + buildAgentSkillBadgeText(analysis.skills, false));
            }
            if (analysis.disabledSkillHits && analysis.disabledSkillHits.length > 0) {
                agentAppendLog("  Skills skipped by toggle: " + buildAgentSkillBadgeText(analysis.disabledSkillHits, false));
            }
            agentAppendLog("  Model tier: " + (analysis.modelTier || "small").toUpperCase());
            var maxBatchCalls = analysis.isFathersMoneyMode ? 60 : (analysis.isGoldMode ? 50 : (analysis.isHardMode ? 40 : 25));
            agentAppendLog("  Execution mode: single-shot (" + maxBatchCalls + " calls max)");
            agentAppendLog("");

            var planningPrompt = prompt;
            var preContext = { comps: {}, layers: {}, lastComp: null, lastLayer: null };
            var preRead = agentTool_getCompInfo({ compName: null }, preContext);
            if (preRead && preRead.ok) {
                var preReadShort = shortPreview(preRead.msg, 600);
                planningPrompt += "\n\nCurrent comp snapshot:\n" + preReadShort;
                agentAppendLog("  Readback before planning: " + preReadShort);
            } else {
                agentAppendLog("  Readback before planning unavailable.");
            }
            agentAppendLog("");

            var runLabel = analysis.isFathersMoneyMode ? "\u23f3 Father's Mode..." : (analysis.isHardMode ? "\u23f3 Hard Mode..." : "\u23f3 Planning...");
            agentRunBtn.updateText(runLabel);
            if (win.update) win.update();

            var agentPlan = callAgentAPI(planningPrompt, model, apiKey, apiUrl, function (msg) {
                agentAppendLog("  " + msg);
            }, analysis, { maxBatchCalls: maxBatchCalls });

            agentRunBtn.updateText("\u2bc1 Run Agent");
            if (win.update) win.update();

            if (!agentPlan) {
                agentAppendLog("\n\u274c Agent planning failed. Check messages above.");
                appendHistory("Agent planning failed.");
                return;
            }

            function logPlanWarnings(prefix, warnings) {
                if (!warnings || !(warnings instanceof Array) || warnings.length === 0) return;
                var warnLimit = Math.min(warnings.length, 5);
                agentAppendLog(prefix + " normalization notes (" + warnings.length + "):");
                for (var wi = 0; wi < warnLimit; wi++) {
                    agentAppendLog("  - " + shortPreview(warnings[wi], 180));
                }
                if (warnings.length > warnLimit) {
                    agentAppendLog("  - ... +" + (warnings.length - warnLimit) + " more");
                }
            }

            function mergeSummary(into, part) {
                if (!into || !part) return into;
                into.successCount += part.successCount || 0;
                into.failCount += part.failCount || 0;
                into.recoveredCount += part.recoveredCount || 0;
                into.verificationFailCount += part.verificationFailCount || 0;
                into.repairAttemptCount += part.repairAttemptCount || 0;
                if (part.stoppedEarly) into.stoppedEarly = true;
                if (part.failedSteps && part.failedSteps.length > 0) {
                    for (var i = 0; i < part.failedSteps.length; i++) into.failedSteps.push(part.failedSteps[i]);
                }
                if (part.failedCalls && part.failedCalls.length > 0) {
                    for (var c = 0; c < part.failedCalls.length; c++) into.failedCalls.push(part.failedCalls[c]);
                }
                if (part.stepRecords && part.stepRecords.length > 0) {
                    for (var s = 0; s < part.stepRecords.length; s++) into.stepRecords.push(part.stepRecords[s]);
                }
                return into;
            }

            // Single-shot execution: one plan, one execution pass, done.

            var context = {
                comps: {},
                layers: {},
                lastComp: null,
                lastLayer: null,
                runId: runId,
                expressionFailureMap: {},
                agentConnection: { model: model, apiKey: apiKey, apiUrl: apiUrl },
                analysis: analysis
            };
            var runSummary = {
                successCount: 0,
                failCount: 0,
                failedSteps: [],
                failedCalls: [],
                stepRecords: [],
                recoveredCount: 0,
                verificationFailCount: 0,
                repairAttemptCount: 0,
                stoppedEarly: false
            };
            // ── SINGLE-SHOT EXECUTION ──────────────────────────────────────
            var calls = (agentPlan && agentPlan.tool_calls instanceof Array) ? agentPlan.tool_calls : [];
            logPlanWarnings("Plan", agentPlan ? agentPlan.warnings : null);
            agentAppendLog("Plan: " + ((agentPlan && agentPlan.plan) ? agentPlan.plan : "(no plan text)"));
            agentAppendLog("  " + calls.length + " tool call(s) queued.");

            var _undoGroupOpen = false;
            app.beginUndoGroup("Balongra Agent: " + prompt.substr(0, 60));
            _undoGroupOpen = true;

            try {
                if (calls.length === 0) {
                    agentAppendLog("  \u26a0 Planner returned no executable calls. Check prompt and try again.");
                } else {
                    var doRun = true;
                    if (uiState.agentPlanPreviewEnabled !== false) {
                        var preview = "Plan Preview\n\n" + ((agentPlan && agentPlan.plan) ? agentPlan.plan : "(no plan text)") + "\n\nTool calls:\n";
                        var previewLimit = Math.min(calls.length, 20);
                        for (var pi = 0; pi < previewLimit; pi++) {
                            preview += (pi + 1) + ". " + (calls[pi].tool || calls[pi].name || "?") + "\n";
                        }
                        if (calls.length > previewLimit) preview += "... +" + (calls.length - previewLimit) + " more\n";
                        preview += "\nRun this plan?";
                        if (!confirm(preview)) {
                            doRun = false;
                            agentAppendLog("Execution canceled.");
                            appendHistory("Agent run canceled at plan preview.");
                        }
                    } else {
                        agentAppendLog("Plan preview disabled. Running immediately.");
                    }
                    if (doRun) {
                        var mainExec = runToolCalls(calls, context, "Main");
                        mergeSummary(runSummary, mainExec);
                        if (mainExec.stoppedEarly) agentAppendLog("  \u26a0 Stopped early by circuit breaker.");
                    }
                }
            } catch (execErr) {
                agentAppendLog("  \u2715 Execution error: " + execErr.toString());
            } finally {
                // Always close undo group — even if a tool throws an uncaught error.
                // Without this, AE's undo stack gets corrupted and Undo stops working.
                app.endUndoGroup();
                _undoGroupOpen = false;
            }

            // Wire Repair button with failed calls from this run
            var _lastFailedCalls = runSummary.failedCalls ? runSummary.failedCalls.slice(0) : [];
            if (_lastFailedCalls.length > 0) {
                agentRepairBtn.enabled = true;
                (function(failedCalls, reqPrompt, reqModel, reqKey, reqUrl, reqMaxBatch, reqAnalysis) {
                    var _repairUsed = false; // hard limit: one repair per run
                    agentRepairBtn.onClick = function () {
                        if (_repairUsed) {
                            alert("Repair has already been used once for this run.\n\nRun the agent again if you want to retry from scratch.");
                            agentRepairBtn.enabled = false;
                            return;
                        }
                        if (!failedCalls || failedCalls.length === 0) { alert("No failed steps to repair."); return; }
                        if (!confirm("Run a ONE-TIME repair pass on " + failedCalls.length + " failed step(s)?\n\nThis makes one API call and executes corrective tool calls.\nRepair can only be used once per run — use Undo Last Run to revert.")) return;
                        _repairUsed = true;          // consumed — no further retries
                        agentRepairBtn.enabled = false;
                        agentAppendLog("");
                        agentAppendLog("🔧 Repair (1 of 1 allowed): " + failedCalls.length + " failed step(s)...");
                        var repCtx = { comps: {}, layers: {}, lastComp: null, lastLayer: null,
                            runId: "REPAIR", expressionFailureMap: {},
                            agentConnection: { model: reqModel, apiKey: reqKey, apiUrl: reqUrl }, analysis: reqAnalysis };
                        var snap = agentTool_getCompInfo({ compName: null }, repCtx);
                        var snapText = (snap && snap.ok) ? shortPreview(snap.msg, 800) : "";
                        var fSum = [];
                        for (var rfi = 0; rfi < Math.min(failedCalls.length, 12); rfi++) {
                            var fc = failedCalls[rfi];
                            if (fc && fc.tool) {
                                var fca = ""; try { fca = JSON.stringify(fc.args || {}); } catch(e) {}
                                fSum.push("- " + fc.tool + " " + shortPreview(fca, 100) + (fc.error ? " -> " + shortPreview(fc.error, 70) : ""));
                            }
                        }
                        var rPrompt = "REPAIR SESSION. Fix ONLY these failed steps. Do NOT re-plan the project.\n" +
                            "Original request: " + reqPrompt + "\n\nFailed steps:\n" + fSum.join("\n") +
                            (snapText ? "\n\nCurrent comp state:\n" + snapText : "") +
                            "\n\nReturn ONLY corrective tool calls. Max " + reqMaxBatch + " calls.";
                        agentRunBtn.updateText("\u23f3 Repairing...");
                        if (win.update) win.update();
                        var rPlan = callAgentAPI(rPrompt, reqModel, reqKey, reqUrl, function(m) { agentAppendLog("  " + m); },
                            reqAnalysis, { isRepair: true, maxBatchCalls: reqMaxBatch });
                        agentRunBtn.updateText("\u2bc1 Run Agent");
                        if (win.update) win.update();
                        if (rPlan && rPlan.tool_calls && rPlan.tool_calls.length > 0) {
                            agentAppendLog("  " + rPlan.tool_calls.length + " corrective call(s) queued.");
                            app.beginUndoGroup("Balongra Agent: Repair");
                            try {
                                var rExec = runToolCalls(rPlan.tool_calls, repCtx, "Repair");
                                agentAppendLog("  Repair done: " + rExec.successCount + " fixed, " + rExec.failCount + " still failed.");
                                if (rExec.failCount > 0) {
                                    agentAppendLog("  Still failing — run agent again to retry from scratch.");
                                }
                            } catch (repErr) {
                                agentAppendLog("  \u2715 Repair execution error: " + repErr.toString());
                            } finally {
                                app.endUndoGroup();
                            }
                        } else {
                            agentAppendLog("  \u26a0 Repair returned no executable calls.");
                        }
                        // Button stays disabled — repair is spent
                    };
                })(_lastFailedCalls, prompt, model, apiKey, apiUrl, maxBatchCalls, analysis);
            } else {
                agentRepairBtn.enabled = false;
            }

            var totalSuccess = runSummary.successCount;
            var totalFail = runSummary.failCount;
            var allFailed = runSummary.failedSteps.slice(0);
            var allStepRecords = runSummary.stepRecords ? runSummary.stepRecords.slice(0) : [];

            var skillEval = agentEvaluateSkillCompliance(analysis, allStepRecords);
            var qualityScore = agentComputeRunQuality(runSummary, null, skillEval);

            var postRead = agentTool_getCompInfo({ compName: null }, context);
            if (postRead && postRead.ok) {
                agentAppendLog("");
                agentAppendLog("Readback after run: " + shortPreview(postRead.msg, 700));
            }

            agentAppendLog("");
            agentAppendLog("\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014", true);
            var totalSkipped = runSummary.skippedCount || 0;
            var skippedNote = (totalSkipped > 0) ? (", " + totalSkipped + " not attempted (circuit breaker)") : "";
            if (totalFail === 0 && totalSkipped === 0) {
                agentAppendLog("\u2728 Done! All " + totalSuccess + " tool calls succeeded.");
                appendHistory("Agent run completed: " + totalSuccess + " succeeded, 0 failed.");
            } else {
                agentAppendLog("\u26a0 Done: " + totalSuccess + " succeeded, " + totalFail + " failed" + skippedNote + ".");
                agentAppendLog("  Use \u21ba Undo Last Run button to revert, or 🔧 Repair to fix failed steps.");
                appendHistory("Agent run completed: " + totalSuccess + " succeeded, " + totalFail + " failed" + skippedNote + ".");
            }

            lastAgentRunArtifact = {
                runId: runId,
                prompt: prompt,
                model: model,
                mode: analysis.isFathersMoneyMode ? "father" : (analysis.isHardMode ? "hard" : "normal"),
                analysis: analysis,
                plan: agentPlan,
                mainSummary: runSummary,
                skillEvaluation: skillEval,
                qualityScore: qualityScore,
                failedSteps: allFailed
            };
            try { appendRuntimeLog("AGENT_RUN_JSON", JSON.stringify(lastAgentRunArtifact)); } catch (runLogErr) { }
            } catch (agentFatalErr) {
                var fatalMsg = agentFatalErr ? agentFatalErr.toString() : "Unknown error";
                // Close the undo group if it was opened but the inner finally never ran
                // (i.e. the fatal error occurred before or after the inner try block).
                if (_undoGroupOpen) {
                    try { app.endUndoGroup(); } catch (ugErr) {}
                    _undoGroupOpen = false;
                }
                try { agentAppendLog("\u274c Fatal error: " + fatalMsg); } catch (le) { }
                try { agentRunBtn.updateText("\u2bc1 Run Agent"); } catch (be) { }
                alert("Agent stopped safely.\n\n" + fatalMsg + "\n\nYour existing work is preserved. Use Undo Last Run if needed.");
            }
        };

        btnBake.onClick = function () {
            var comp = app.project.activeItem;
            if (!comp || !(comp instanceof CompItem)) { alert("Please select a composition."); return; }
            if (comp.selectedProperties.length === 0) { alert("Please select the specific properties you want to bake."); return; }

            app.beginUndoGroup("Bake Expressions");
            try {
                // Command ID 2639 is "Convert Expression to Keyframes"
                app.executeCommand(2639);
                alert("Expressions successfully baked to keyframes.");
            } catch (e) {
                alert("Could not bake expressions. Make sure you have properties with expressions selected.");
            }
            app.endUndoGroup();
        };
        btnError.onClick = function () {
            var comp = app.project.activeItem;
            if (!comp || !(comp instanceof CompItem)) { alert("Please open a composition first."); return; }

            var brokenCount = 0;
            var brokenProps = [];

            // Recursive function to check all properties
            function checkErrorsRecursive(propGroup) {
                if (!propGroup || !propGroup.numProperties) return;
                for (var i = 1; i <= propGroup.numProperties; i++) {
                    var prop = propGroup.property(i);
                    if (prop.propertyType === PropertyType.PROPERTY) {
                        try {
                            if (prop.canSetExpression && prop.expression !== "" && prop.expressionError !== "") {
                                brokenCount++;
                                brokenProps.push(prop);
                            }
                        } catch (e) { }
                    } else if (prop.propertyType === PropertyType.INDEXED_GROUP || prop.propertyType === PropertyType.NAMED_GROUP) {
                        checkErrorsRecursive(prop);
                    }
                }
            }

            for (var l = 1; l <= comp.numLayers; l++) {
                checkErrorsRecursive(comp.layer(l));
            }

            if (brokenCount === 0) {
                alert("Great news! The Error Doctor found 0 broken expressions in this composition.");
            } else {
                var tryFix = confirm("The Error Doctor found " + brokenCount + " broken expressions.\n\nClick YES to auto-fix and re-enable them first.\nClick NO to skip repair and go straight to disable options.");
                if (tryFix) {
                    app.beginUndoGroup("Repair Broken Expressions");
                    var fixed = 0;
                    var unresolved = [];
                    for (var b = 0; b < brokenProps.length; b++) {
                        try {
                            var bp = brokenProps[b];
                            var expr = sanitizeExpressionForAE(bp.expression || "");
                            bp.expression = expr;
                            bp.expressionEnabled = true;
                            if (bp.expressionError && bp.expressionError !== "") unresolved.push(bp);
                            else fixed++;
                        } catch (fxErr) {
                            unresolved.push(brokenProps[b]);
                        }
                    }
                    app.endUndoGroup();
                    appendHistory("Error Doctor auto-fix: " + fixed + " fixed, " + unresolved.length + " unresolved.");

                    if (unresolved.length === 0) {
                        alert("Auto-fix complete. All " + fixed + " broken expressions were repaired.");
                    } else {
                        var disableRemaining = confirm("Auto-fix repaired " + fixed + " expression(s), but " + unresolved.length + " are still broken.\n\nDisable unresolved expressions now?");
                        if (disableRemaining) {
                            app.beginUndoGroup("Disable Unresolved Expressions");
                            for (var u = 0; u < unresolved.length; u++) {
                                try { unresolved[u].expressionEnabled = false; } catch (de) { }
                            }
                            app.endUndoGroup();
                            alert("Disabled " + unresolved.length + " unresolved expressions. " + fixed + " were repaired and kept enabled.");
                        }
                    }
                } else {
                    var disable = confirm("Disable all " + brokenCount + " broken expressions?");
                    if (disable) {
                        app.beginUndoGroup("Disable Broken Expressions");
                        for (var d = 0; d < brokenProps.length; d++) {
                            brokenProps[d].expressionEnabled = false;
                        }
                        app.endUndoGroup();
                        appendHistory("Error Doctor disabled " + brokenCount + " broken expressions.");
                        alert("All " + brokenCount + " broken expressions have been safely disabled.");
                    }
                }
            }
        };
        // ========================================
        // SAVE API KEYS HANDLER
        // ========================================
        btnSaveApi.onClick = function () {
            var sel = apiDropdown.selection ? apiDropdown.selection.text : "ChatGPT";
            apiSettings.activeModel = sel;
            uiState.selectedModel = sel;

            apiSettings.openAIKey = apiGptInput.text;
            apiSettings.anthropicKey = apiClaudeInput.text;
            apiSettings.geminiKey = apiGeminiInput.text;
            apiSettings.kimiKey = apiKimiInput.text;
            apiSettings.openRouterKey = apiOpRouterInput.text;
            apiSettings.groqKey = apiGroqInput.text;
            apiSettings.cerebrasKey = apiCerebrasInput.text;
            apiSettings.nimKey = apiNimInput.text;
            apiSettings.githubKey = apiGithubInput.text;
            apiSettings.mistralKey = apiMistralInput.text;
            apiSettings.customApiKey = apiCustomKeyInput.text;
            apiSettings.customEndpointUrl = apiCustomUrlInput.text;
            apiSettings.customModel = apiCustomModelInput.text || "local-model";

            saveExpressions(); // apiSettings is saved alongside the expression library
            var extraInfo = "";
            if (sel === "Custom Endpoint") {
                extraInfo = "\nEndpoint: " + (apiSettings.customEndpointUrl || "(not set)") + "\nModel: " + (apiSettings.customModel || "local-model");
            }
            setApiStatus("Saved (" + sel + ")");
            appendHistory("API settings saved for " + sel);
            alert("API settings saved successfully for " + sel + "." + extraInfo);
        };

        // ========================================
        // TEST CONNECTION HANDLER
        // ========================================
        btnTestApi.onClick = function () {
            var model = apiDropdown.selection ? apiDropdown.selection.text : "ChatGPT";
            var conn = resolveModelConnection(model, false);
            var apiKey = conn.apiKey;
            var apiUrl = conn.apiUrl;
            var tStart = (new Date()).getTime();

            if (conn.keyRequired && (!apiKey || apiKey === "")) {
                setApiStatus("Missing key");
                alert("No API key entered for " + model + ".\n\nPlease paste your key in the field above and try again.");
                return;
            }

            if (!apiUrl || apiUrl === "") {
                setApiStatus("Missing endpoint");
                alert("No API endpoint configured for " + model + ".\n\nPlease enter a valid endpoint URL and try again.");
                return;
            }

            // Build a minimal test payload
            var testPayload = buildPayload(model, "Reply with exactly: OK", "Test");

            var tmpFile = new File(Folder.temp.fullName + "/balongra_test_payload.json");
            tmpFile.encoding = "UTF-8";
            tmpFile.open("w");
            tmpFile.write(testPayload);
            tmpFile.close();

            var sanitizedKey = apiKey.replace(/[^a-zA-Z0-9_.\-]/g, "");
            var sanitizedUrl = (apiUrl || "").replace(/['"`$;&|<>\r\n\\]/g, "");
            var cmd = "";
            var isMac = ($.os.indexOf("Mac") !== -1);
            if (isMac) {
                var hdr = " -H 'Content-Type: application/json'";
                if (modelUsesBearerAuth(model) && sanitizedKey !== "") hdr += " -H 'Authorization: Bearer " + sanitizedKey + "'";
                if (model === "Claude") hdr += " -H 'x-api-key: " + sanitizedKey + "' -H 'anthropic-version: 2023-06-01'";
            if (model === "Gemini" && sanitizedKey !== "") hdr += " -H 'x-goog-api-key: " + sanitizedKey + "'";
                cmd = 'curl -s -m 15 -X POST "' + sanitizedUrl + '"' + hdr + ' -d @"' + tmpFile.fsName + '"';
            } else {
                var psH = "@{'Content-Type'='application/json';";
                if (modelUsesBearerAuth(model) && sanitizedKey !== "") psH += "'Authorization'='Bearer " + sanitizedKey + "'";
                if (model === "Claude") psH += "'x-api-key'='" + sanitizedKey + "';'anthropic-version'='2023-06-01'";
            if (model === "Gemini" && sanitizedKey !== "") psH += "'x-goog-api-key'='" + sanitizedKey + "'";
                psH += "}";
                cmd = "powershell -Command \"$body = Get-Content -Raw -Path '" + tmpFile.fsName.replace(/'/g, "''") + "'; (Invoke-WebRequest -Uri '" + sanitizedUrl.replace(/'/g, "''") + "' -Method Post -Headers " + psH + " -Body $body -ContentType 'application/json' -TimeoutSec 15).Content\"";
            }

            btnTestApi.updateText("\u23f3 TESTING...");
            setApiStatus("Testing...");
            if (win.update) win.update();

            var response = "";
            try {
                response = system.callSystem(cmd);
            } catch (e) {
                response = "";
            } finally {
                try { if (tmpFile && tmpFile.exists) tmpFile.remove(); } catch (x) { }
            }

            btnTestApi.updateText("TEST CONNECTION");
            if (win.update) win.update();

            if (!response || response === "") {
                setApiStatus("Failed");
                appendHistory("API test failed for " + model + " (empty response)");
                alert("\u274c Connection failed for " + model + ".\n\nPossible causes:\n\u2022 No internet connection\n\u2022 Firewall blocking curl\n\u2022 API service is down");
                return;
            }

            try {
                var jsonResp = JSON.parse(response);
                if (jsonResp.error) {
                    var errMsg = jsonResp.error.message || jsonResp.error.type || JSON.stringify(jsonResp.error);
                    if (errMsg.indexOf("rate") !== -1 || errMsg.indexOf("429") !== -1 || errMsg.indexOf("quota") !== -1) {
                        setApiStatus("Valid key (rate-limited)");
                        appendHistory("API test valid for " + model + " (rate-limited)");
                        alert("\u2705 " + model + " API key is VALID!\n\n(Rate limited right now, but the key works.)");
                    } else {
                        setApiStatus("API error");
                        appendHistory("API test error for " + model + ": " + errMsg.substr(0, 80));
                        alert("\u274c API Error from " + model + ":\n\n" + errMsg);
                    }
                } else {
                    var elapsed = (new Date()).getTime() - tStart;
                    setApiStatus("Connected (" + elapsed + " ms)");
                    appendHistory("API test success for " + model + " in " + elapsed + " ms");
                    alert("\u2705 " + model + " connection successful!");
                }
            } catch (pe) {
                setApiStatus("Unknown response");
                appendHistory("API test uncertain for " + model + " (non-JSON response)");
                alert("\u26a0 " + model + " responded, but the response was not valid JSON.\n\nFirst 200 chars:\n" + response.substr(0, 200));
            }
        };

        // ========================================
        // EXPORT LIBRARY HANDLER
        // ========================================
        btnExportLib.onClick = function () {
            var isMac = ($.os.indexOf("Mac") !== -1);
            var exportFile = File.saveDialog("Export Expression Library", isMac ? undefined : "JSON Files:*.json,All Files:*.*");
            if (!exportFile) return;

            try {
                var exportData = {
                    library: expressionLibrary,
                    apiSettings: apiSettings
                };
                exportFile.encoding = "UTF-8";
                exportFile.open("w");
                exportFile.write(JSON.stringify(exportData));
                exportFile.close();
                appendHistory("Library exported (" + expressionLibrary.length + " expressions)");
                alert("\u2705 Library exported successfully!\n\n" + expressionLibrary.length + " expressions saved to:\n" + exportFile.fsName);
            } catch (e) {
                alert("Export failed: " + e.toString());
            }
        };

        // ========================================
        // IMPORT LIBRARY HANDLER
        // ========================================
        btnImportLib.onClick = function () {
            var isMac = ($.os.indexOf("Mac") !== -1);
            var importFile = File.openDialog("Import Expression Library", isMac ? undefined : "JSON Files:*.json,All Files:*.*");
            if (!importFile) return;

            try {
                importFile.encoding = "UTF-8";
                importFile.open("r");
                var data = importFile.read();
                importFile.close();

                var imported = JSON.parse(data);
                var importedLib = null;

                if (imported && imported.library) {
                    importedLib = imported.library;
                } else if (imported instanceof Array) {
                    importedLib = imported;
                }

                if (!importedLib || importedLib.length === 0) {
                    alert("No valid expressions found in the selected file.");
                    return;
                }

                var mode = confirm("Found " + importedLib.length + " expressions.\n\nClick OK to MERGE with your current library.\nClick Cancel to REPLACE your entire library.");

                if (mode) {
                    // Merge — append imported expressions
                    for (var im = 0; im < importedLib.length; im++) {
                        ensureExpressionMeta(importedLib[im]);
                        expressionLibrary.push(importedLib[im]);
                    }
                    appendHistory("Library import merged " + importedLib.length + " expressions");
                    alert("\u2705 Merged " + importedLib.length + " expressions into your library.\nTotal: " + expressionLibrary.length);
                } else {
                    expressionLibrary = importedLib;
                    for (var ie = 0; ie < expressionLibrary.length; ie++) ensureExpressionMeta(expressionLibrary[ie]);
                    appendHistory("Library import replaced with " + importedLib.length + " expressions");
                    alert("\u2705 Replaced library with " + importedLib.length + " imported expressions.");
                }

                saveExpressions();
                updateExpressionList(expressionList, searchInput.text, currentGroupFilter, countLabel);
            } catch (e) {
                alert("Import failed: " + e.toString());
            }
        };

        // ========================================
        // RESET DEFAULTS HANDLER
        // ========================================
        btnResetLib.onClick = function () {
            if (!confirm("WARNING: This will replace your ENTIRE expression library with the factory defaults.\n\nAll custom and AI-generated expressions will be lost.\n\nAre you sure?")) return;
            if (!confirm("FINAL WARNING: This action cannot be undone.\n\nProceed with factory reset?")) return;

            expressionLibrary = defaultExpressions.slice();
            searchInput.text = "";
            uiState.lastSearchQuery = "";
            uiState.lastGroupFilter = currentGroupFilter;
            saveExpressions();
            updateExpressionList(expressionList, "", currentGroupFilter, countLabel);
            appendHistory("Library reset to defaults (" + expressionLibrary.length + " expressions)");
            alert("\u2705 Expression library has been reset to " + expressionLibrary.length + " factory defaults.");
        };

        // Load existing keys into UI if present — AFTER loadExpressions
        // (moved below the load block so apiSettings is populated from disk first)

        btnAIDirect.onClick = function () {
            var model = apiDropdown.selection ? apiDropdown.selection.text : apiSettings.activeModel;
            var conn = resolveModelConnection(model, true);
            var apiKey = conn.apiKey;
            var apiUrl = conn.apiUrl;

            if (conn.keyRequired && (!apiKey || apiKey === "")) {
                alert("Your " + model + " API key is empty.\n\nPaste it in the API Settings section below and click Save.");
                return;
            }
            if (!apiUrl || apiUrl === "") {
                alert("No API endpoint configured for " + model + ".\n\nSet it in API Settings and click Save.");
                return;
            }

            var userInput = null;
            var promptWin = new Window("dialog", "\u2727 Auto-Generate Expression");
            promptWin.orientation = "column";
            promptWin.alignChildren = ["fill", "top"];
            promptWin.add("statictext", undefined, "What should this expression do? (e.g., 'Make layer hover up and down')");
            var pInput = promptWin.add("edittext", undefined, "", { multiline: true });
            pInput.preferredSize = [350, 80];
            pInput.active = true; // Set focus

            var promptBtnGrp = promptWin.add("group");
            promptBtnGrp.alignment = ["right", "center"];
            var promptCancel = promptBtnGrp.add("button", undefined, "Cancel");
            var promptOk = promptBtnGrp.add("button", undefined, "Generate");

            promptCancel.onClick = function () { promptWin.close(0); };
            promptOk.onClick = function () {
                if (pInput.text !== "") {
                    userInput = pInput.text;
                    promptWin.close(1);
                } else {
                    alert("Please enter a description.");
                }
            };

            promptWin.center();
            if (promptWin.show() === 0 || !userInput) return;

            // --- Internal function: call the API and return the parsed expression or null ---
            function callAI(description) {
                var maxRetries = 2;
                var attempts = 0;

                while (attempts <= maxRetries) {
                    attempts++;

                    var sysPrompt = buildAISystemPrompt(description);
                    var payloadStr = buildPayload(model, sysPrompt, "Generate the After Effects expression JSON now.");

                    // Write payload to temp file
                    var tmpFile = new File(Folder.temp.fullName + "/expresso_ai_payload_attempt" + attempts + ".json");
                    try {
                        tmpFile.encoding = "UTF-8";
                        tmpFile.open("w");
                        tmpFile.write(payloadStr);
                        tmpFile.close();
                    } catch (fileErr) {
                        alert("Failed to write temp file: " + fileErr.toString());
                        return null;
                    }

                    // Build curl/powershell command
                    var sanitizedKey = apiKey.replace(/[^a-zA-Z0-9_.\-]/g, ""); // Shell injection mitigation — use local var to avoid mutating closure
                    var sanitizedUrl = (apiUrl || "").replace(/['"`$;&|<>\r\n\\]/g, "");
                    var cmd = "";
                    var isMac = ($.os.indexOf("Mac") !== -1);
                    if (isMac) {
                        var hdr = " -H 'Content-Type: application/json'";
                        if (modelUsesBearerAuth(model) && sanitizedKey !== "") hdr += " -H 'Authorization: Bearer " + sanitizedKey + "'";
                        if (model === "Claude") hdr += " -H 'x-api-key: " + sanitizedKey + "' -H 'anthropic-version: 2023-06-01'";
                        if (model === "Gemini" && sanitizedKey !== "") hdr += " -H 'x-goog-api-key: " + sanitizedKey + "'";
                        cmd = 'curl -s -X POST "' + sanitizedUrl + '"' + hdr + ' -d @"' + tmpFile.fsName + '"';
                    } else {
                        var psH = "@{'Content-Type'='application/json';";
                        if (modelUsesBearerAuth(model) && sanitizedKey !== "") psH += "'Authorization'='Bearer " + sanitizedKey + "'";
                        if (model === "Claude") psH += "'x-api-key'='" + sanitizedKey + "';'anthropic-version'='2023-06-01'";
                        if (model === "Gemini" && sanitizedKey !== "") psH += "'x-goog-api-key'='" + sanitizedKey + "'";
                        psH += "}";
                        cmd = "powershell -Command \"$body = Get-Content -Raw -Path '" + tmpFile.fsName.replace(/'/g, "''") + "'; (Invoke-WebRequest -Uri '" + sanitizedUrl.replace(/'/g, "''") + "' -Method Post -Headers " + psH + " -Body $body -ContentType 'application/json').Content\"";
                    }

                    // Execute (always cleanup temp file, even on shell failures)
                    var responseStr = "";
                    var shellErr = null;
                    try {
                        if (attempts > 1) {
                            btnAIDirect.updateText("\u23f3 Retrying (" + (attempts - 1) + ")...");
                        } else {
                            btnAIDirect.updateText("\u23f3 Generating...");
                        }
                        if (win.update) win.update();
                        responseStr = system.callSystem(cmd);
                    } catch (err) {
                        shellErr = err;
                    } finally {
                        btnAIDirect.updateText("GENERATE EXPRESSION");
                        if (win.update) win.update();
                        try { if (tmpFile && tmpFile.exists) tmpFile.remove(); } catch (x) { }
                    }
                    if (shellErr) {
                        alert("Network error: " + shellErr.toString());
                        return null;
                    }

                    if (!responseStr || responseStr === "") {
                        if (attempts <= maxRetries) continue;
                        alert("API returned an empty response.\n\nPossible causes:\n\u2022 No internet connection\n\u2022 Invalid API key\n\u2022 API service is down");
                        return null;
                    }

                    // Parse outer API response
                    var jsonResp;
                    try {
                        jsonResp = JSON.parse(responseStr);
                    } catch (pe) {
                        if (attempts <= maxRetries) continue;
                        alert("API returned invalid JSON.\n\nFirst 300 chars:\n" + responseStr.substr(0, 300));
                        return null;
                    }

                    // Check for API-level errors (Don't retry if the API explicitly refused us)
                    if (jsonResp.error) {
                        var errMsg = jsonResp.error.message || jsonResp.error.type || JSON.stringify(jsonResp.error);
                        alert("API Error from " + model + ":\n\n" + errMsg);
                        return null;
                    }

                    // Extract the AI's text content
                    var rawContent = "";
                    if (modelUsesOpenAIResponseShape(model) && jsonResp.choices && jsonResp.choices.length > 0) {
                        rawContent = jsonResp.choices[0].message.content;
                    } else if (model === "Claude" && jsonResp.content && jsonResp.content.length > 0) {
                        rawContent = jsonResp.content[0].text;
                    } else if (model === "Gemini" && jsonResp.candidates && jsonResp.candidates.length > 0 && jsonResp.candidates[0].content && jsonResp.candidates[0].content.parts && jsonResp.candidates[0].content.parts.length > 0) {
                        rawContent = jsonResp.candidates[0].content.parts[0].text;
                    } else {
                        if (attempts <= maxRetries) continue;
                        alert("Unexpected response format from " + model + ".\n\n" + responseStr.substr(0, 300));
                        return null;
                    }

                    // Step 1 - Extract JSON safely
                    var aiExp = extractJSON(rawContent);
                    if (!aiExp) {
                        if (attempts <= maxRetries) continue;
                        var eWin = new Window("dialog", "AI Parse Error");
                        eWin.orientation = "column";
                        eWin.add("statictext", undefined, "Could not extract valid JSON from AI response after 3 attempts:");
                        var eText = eWin.add("edittext", undefined, rawContent, { multiline: true, scrolling: true });
                        eText.preferredSize = [450, 250];
                        var eClose = eWin.add("button", undefined, "Close");
                        eClose.onClick = function () { eWin.close(); };
                        eWin.center(); eWin.show();
                        return null;
                    }

                    // Step 2 & 3 - Validate presence of required fields
                    if (!aiExp.name || !aiExp.expression || !aiExp.description || !aiExp.targetProperty) {
                        if (attempts <= maxRetries) continue;
                        alert("AI returned JSON but missing required fields.\n\nReceived:\n" + JSON.stringify(aiExp).substr(0, 200));
                        return null;
                    }

                    // Step 4 - Validate no ES6 forbidden syntax
                    var valid = validateExpression(aiExp.expression);
                    if (!valid) {
                        if (attempts <= maxRetries) continue;
                        alert("AI generated invalid ES6 syntax after 3 attempts. Please try rephrasing your prompt.");
                        return null;
                    }

                    // Step 5 - Validate targetProperty
                    var tpValid = false;
                    for (var v = 0; v < validTargetProperties.length; v++) {
                        if (validTargetProperties[v] === aiExp.targetProperty) { tpValid = true; break; }
                    }
                    if (!tpValid) {
                        if (attempts <= maxRetries) continue;
                        aiExp.targetProperty = "Any Property (Manual)"; // Fallback instead of failing entirely on the last attempt
                    }

                    // All checks passed!
                    return aiExp;
                }

                return null;
            }

            // --- Call the AI ---
            var result = callAI(userInput);
            if (!result) return;

            // --- Show Preview Dialog (Palette to allow AE interaction) ---
            var pvWin = new Window("palette", "\u2727 AI Generated Expression — Preview");
            pvWin.orientation = "column";
            pvWin.alignChildren = ["fill", "top"];
            pvWin.preferredSize = [460, -1];

            // Name
            var nameGrp = pvWin.add("group"); nameGrp.orientation = "row"; nameGrp.alignment = ["fill", "top"];
            nameGrp.add("statictext", undefined, "Name:");
            var pvName = nameGrp.add("edittext", undefined, result.name);
            pvName.alignment = ["fill", "center"]; pvName.characters = 30;

            // Target Property dropdown
            var tgtGrp = pvWin.add("group"); tgtGrp.orientation = "row"; tgtGrp.alignment = ["fill", "top"];
            tgtGrp.add("statictext", undefined, "Target:");
            var pvTarget = tgtGrp.add("dropdownlist", undefined, validTargetProperties);
            pvTarget.alignment = ["fill", "center"];
            for (var ti = 0; ti < pvTarget.items.length; ti++) {
                if (pvTarget.items[ti].text === result.targetProperty) { pvTarget.selection = ti; break; }
            }
            if (!pvTarget.selection) pvTarget.selection = pvTarget.items.length - 1;

            // Category dropdown
            var catGrp = pvWin.add("group"); catGrp.orientation = "row"; catGrp.alignment = ["fill", "top"];
            catGrp.add("statictext", undefined, "Category:");
            var assignable = [];
            for (var ag = 0; ag < availableGroups.length; ag++) {
                if (availableGroups[ag] !== "All Groups" && availableGroups[ag] !== "\u2605 Favorites") assignable.push(availableGroups[ag]);
            }
            var pvCat = catGrp.add("dropdownlist", undefined, assignable);
            pvCat.alignment = ["fill", "center"];
            // Default to "AI Generated"
            for (var ci = 0; ci < pvCat.items.length; ci++) {
                if (pvCat.items[ci].text === "AI Generated") { pvCat.selection = ci; break; }
            }
            if (!pvCat.selection) pvCat.selection = 0;

            // Description
            var descGrp = pvWin.add("group"); descGrp.orientation = "column"; descGrp.alignment = ["fill", "top"]; descGrp.alignChildren = ["fill", "top"];
            descGrp.add("statictext", undefined, "Description:");
            var pvDesc = descGrp.add("edittext", undefined, result.description || "");
            pvDesc.characters = 50;

            // Code (editable to allow tweaks before save/test)
            var codeGrp = pvWin.add("group"); codeGrp.orientation = "column"; codeGrp.alignment = ["fill", "top"]; codeGrp.alignChildren = ["fill", "top"];
            codeGrp.add("statictext", undefined, "Expression Code:");
            var pvCode = codeGrp.add("edittext", undefined, result.expression, { multiline: true, scrolling: true });
            pvCode.preferredSize = [-1, 150];

            // Buttons
            var btnGrp = pvWin.add("group"); btnGrp.orientation = "row"; btnGrp.alignment = ["fill", "top"];
            btnGrp.alignChildren = ["fill", "center"];
            var pvDiscard = btnGrp.add("button", undefined, "\u2715 Discard");
            var pvRegen = btnGrp.add("button", undefined, "\u21bb Regenerate");
            var pvApply = buildColBtn(btnGrp, "\u25ba Test Apply", colorOrange);
            var pvSave = btnGrp.add("button", undefined, "\u2713 Save to Library");

            pvDiscard.onClick = function () {
                pvWin.close();
            };

            pvRegen.onClick = function () {
                btnAIDirect.updateText("\u23f3 Regenerating...");
                if (win.update) win.update();
                var newResult = callAI(userInput);
                btnAIDirect.updateText("GENERATE EXPRESSION");
                if (newResult) {
                    pvName.text = newResult.name;
                    pvDesc.text = newResult.description || "";
                    pvCode.text = newResult.expression;
                    for (var tti = 0; tti < pvTarget.items.length; tti++) {
                        if (pvTarget.items[tti].text === newResult.targetProperty) {
                            pvTarget.selection = tti;
                            break;
                        }
                    }
                }
            };

            pvApply.onClick = function () {
                var tempExpr = {
                    name: pvName.text || "AI Test",
                    expression: pvCode.text,
                    targetProperty: pvTarget.selection ? pvTarget.selection.text : "Any Property (Manual)"
                };
                var beforeApply = tempExpr.usageCount || 0;
                applyExpression(tempExpr);
                var appliedNow = (tempExpr.usageCount || 0) - beforeApply;
                if (appliedNow > 0) appendHistory("AI preview expression applied: " + tempExpr.name + " (" + appliedNow + " property(s))");
            };

            pvSave.onClick = function () {
                // Read back edited values
                result.name = pvName.text;
                result.expression = pvCode.text;
                result.description = pvDesc.text;
                result.targetProperty = pvTarget.selection ? pvTarget.selection.text : "Any Property (Manual)";
                result.group = pvCat.selection ? pvCat.selection.text : "AI Generated";
                ensureExpressionMeta(result);
                pvWin.close();

                // Commit to library
                expressionLibrary.push(result);
                saveExpressions();
                appendHistory("AI expression added to library: " + result.name);

                // Switch to Expressions tab + AI Generated group
                switchTab("expr");
                for (var gi = 0; gi < groupDropdown.items.length; gi++) {
                    if (groupDropdown.items[gi].text === "AI Generated") { groupDropdown.selection = gi; break; }
                }
                currentGroupFilter = "AI Generated";
                uiState.lastGroupFilter = currentGroupFilter;
                searchInput.text = "";
                uiState.lastSearchQuery = "";
                updateExpressionList(expressionList, "", "AI Generated", countLabel);
                saveExpressions();

                // Select the newly added expression (last in filtered list)
                if (expressionList.items.length > 0) {
                    expressionList.selection = expressionList.items.length - 1;
                }
                countLabel.text = "\u2728 Expression added! Showing " + filteredIndices.length + " of " + expressionLibrary.length;
            };

            pvWin.center();
            pvWin.show();
        };

        btnAICreate.onClick = function () {
            var pWin = new Window("dialog", "\u2727 Manual AI Prompt Generator");
            pWin.orientation = "column";
            pWin.alignChildren = ["fill", "top"];
            pWin.preferredSize = [500, -1];

            pWin.add("statictext", undefined, "1. Describe your expression:");
            var descGrp = pWin.add("group");
            descGrp.orientation = "row";
            descGrp.alignChildren = ["fill", "center"];
            var pDesc = descGrp.add("edittext", undefined, "Make the layer hover up and down smoothly");
            pDesc.alignment = ["fill", "center"];

            pWin.add("statictext", undefined, "2. Copy this prompt and paste it into ChatGPT, Claude, etc:");
            var pText = pWin.add("edittext", undefined, buildAISystemPrompt(pDesc.text), { multiline: true, scrolling: true });
            pText.preferredSize = [-1, 200];

            // Live update the prompt text when description changes
            pDesc.onChanging = function () {
                pText.text = buildAISystemPrompt(pDesc.text);
            };

            var btnGrp = pWin.add("group");
            btnGrp.orientation = "row";
            btnGrp.alignment = ["fill", "top"];
            btnGrp.alignChildren = ["fill", "center"];

            var btnCopy = btnGrp.add("button", undefined, "\uD83D\uDCCB Copy to Clipboard");
            var btnPaste = btnGrp.add("button", undefined, "\u2192 Paste Response");
            var btnClose = btnGrp.add("button", undefined, "Close");

            btnCopy.onClick = function () {
                var txt = pText.text;
                try {
                    // Try the native method if it exists
                    if (typeof app.copyToClipboard === "function") {
                        app.copyToClipboard(txt);
                    } else {
                        throw "fallback";
                    }
                } catch (e) {
                    // Fallback to callSystem
                    var f = new File(Folder.temp.fullName + "/expresso_clipboard.txt");
                    try {
                        f.encoding = "UTF-8";
                        f.open("w");
                        f.write(txt);
                        f.close();
                        var cmd = ($.os.indexOf("Mac") !== -1) ? "cat \"" + f.fsName + "\" | pbcopy" : "type \"" + f.fsName + "\" | clip";
                        system.callSystem(cmd);
                    } catch (clipErr) {
                    } finally {
                        try { if (f && f.exists) f.remove(); } catch (rmErr) { }
                    }
                }
                alert("\u2705 Copied to clipboard!");
            };

            btnPaste.onClick = function () {
                pWin.close();
                btnAIImport.notify("onClick"); // trigger import dialog
            };

            btnClose.onClick = function () { pWin.close(); };

            pWin.center();
            pWin.show();
        };

        btnAIImport.onClick = function () {
            var iWin = new Window("dialog", "Import AI Expression");
            iWin.orientation = "column";
            iWin.alignChildren = ["fill", "top"];

            iWin.add("statictext", undefined, "Paste the RAW JSON output from the AI here:");
            var iText = iWin.add("edittext", undefined, "", { multiline: true, scrolling: true });
            iText.preferredSize = [450, 250];

            var iGroup = iWin.add("group");
            iGroup.orientation = "row";
            iGroup.alignChildren = ["fill", "center"];

            var iBtnImportText = iGroup.add("button", undefined, "Import from Text");
            var iBtnImportFile = iGroup.add("button", undefined, "Import from .json File");
            var iClose = iGroup.add("button", undefined, "Cancel");

            function processImport(rawStr) {
                var aiExp = extractJSON(rawStr);

                if (aiExp && aiExp.name && aiExp.expression) {
                    if (!validateExpression(aiExp.expression)) {
                        alert("Warning: This expression contains forbidden ES6 syntax (let, const, arrow functions, etc) and may not work in After Effects.");
                    }

                    // Pre-fill undefined properties to avoid errors
                    if (!aiExp.targetProperty) aiExp.targetProperty = "Any Property (Manual)";
                    aiExp.group = "AI Generated"; // Auto assign category
                    ensureExpressionMeta(aiExp);

                    expressionLibrary.push(aiExp);
                    saveExpressions();

                    // Switch to Expressions tab + AI Generated group
                    switchTab("expr");
                    for (var gi = 0; gi < groupDropdown.items.length; gi++) {
                        if (groupDropdown.items[gi].text === "AI Generated") { groupDropdown.selection = gi; break; }
                    }
                    currentGroupFilter = "AI Generated";
                    uiState.lastGroupFilter = currentGroupFilter;
                    searchInput.text = "";
                    uiState.lastSearchQuery = "";
                    updateExpressionList(expressionList, "", "AI Generated", countLabel);
                    saveExpressions();

                    // Select the newly added expression
                    if (expressionList.items.length > 0) {
                        expressionList.selection = expressionList.items.length - 1;
                    }
                    countLabel.text = "\u2728 Expression added! Showing " + filteredIndices.length + " of " + expressionLibrary.length;

                    appendHistory("Imported AI expression: " + aiExp.name);
                    iWin.close();
                    alert("\u2728 Successfully imported AI Expression:\n" + aiExp.name);
                } else {
                    // Parse failure UI
                    var eWin = new Window("dialog", "Parse Error");
                    eWin.orientation = "column";
                    eWin.add("statictext", undefined, "Failed to parse AI response. Ensure it's valid JSON with 'name' and 'expression'.");
                    var eText = eWin.add("edittext", undefined, rawStr, { multiline: true, scrolling: true, readonly: true });
                    eText.preferredSize = [450, 200];
                    var eClose = eWin.add("button", undefined, "Close");
                    eClose.onClick = function () { eWin.close(); };
                    eWin.center(); eWin.show();
                }
            }

            iBtnImportText.onClick = function () {
                if (!iText.text) return;
                processImport(iText.text);
            };

            iBtnImportFile.onClick = function () {
                var isMac = ($.os.indexOf("Mac") !== -1);
                var jsonFile = File.openDialog("Select AI JSON Response", isMac ? undefined : "JSON Files:*.json,All Files:*.*");
                if (jsonFile) {
                    jsonFile.open("r");
                    var content = jsonFile.read();
                    jsonFile.close();
                    if (content) {
                        iText.text = content;
                        processImport(content);
                    }
                }
            };

            iClose.onClick = function () { iWin.close(); };
            iWin.center();
            iWin.show();
        };

        function applyResponsiveSizing() {
            sizePrimaryRow(navBar, 88);
            sizePrimaryRow(exprAiActionRow, 120);
            sizePrimaryRow(agentRow, 130);
            sizePrimaryRow(aiMovedBtnRow, 150);
            sizePrimaryRow(historyRow, 128);
            sizePrimaryRow(agentLogActions, 120);

            sizeCompactRow(listActionsGroup);
            sizeCompactRow(scActions);
            sizeCompactRow(actionButtonGroup);
            sizeCompactRow(scBtnGroup);

            sizeSingleButton(toggleEditBtn, 220);
            sizeSingleButton(toggleScEditBtn, 220);
            sizeSingleButton(agentRunBtn, 180);
            sizeSingleButton(btnSaveApi, 170);
            sizeSingleButton(btnTestApi, 170);

            var panelH = (win.size && win.size[1]) ? win.size[1] : 640;
            var panelW = (win.size && win.size[0]) ? win.size[0] : 520;
            var rowH = clampNum(Math.round(panelH * 0.048), 24, 46);

            filterGroup.minimumSize = [-1, rowH];
            groupDropdown.preferredSize = [clampNum(Math.round(panelW * 0.23), 120, 230), rowH];
            sortDropdown.preferredSize = [clampNum(Math.round(panelW * 0.20), 110, 210), rowH];
            searchClearBtn.preferredSize = [clampNum(Math.round(panelW * 0.13), 82, 150), rowH];
            searchInput.preferredSize = [-1, rowH];
        }


        // Tab Navigation Logic
        var _currentTab = "";
        function switchTab(activeTab) {
            if (activeTab !== "expr" && activeTab !== "script" && activeTab !== "tools" && activeTab !== "agent") {
                activeTab = "expr";
            }
            // Skip full layout pass if nothing changed
            if (_currentTab === activeTab) return;
            _currentTab = activeTab;

            tabs.expr.visible = (activeTab === 'expr');
            tabs.script.visible = (activeTab === 'script');
            tabs.tools.visible = (activeTab === 'tools');
            tabs.agent.visible = (activeTab === 'agent');
            setTabState(btnTabExpr, activeTab === 'expr');
            setTabState(btnTabScript, activeTab === 'script');
            setTabState(btnTabTools, activeTab === 'tools');
            setTabState(btnTabAgent, activeTab === 'agent');
            if (uiState.lastTab !== activeTab) {
                uiState.lastTab = activeTab;
            }
            // Single layout pass — no redundant resize() call
            try { win.layout.layout(true); } catch (e) {}
        }

        btnTabExpr.onClick = function () { switchTab('expr'); };
        btnTabScript.onClick = function () { switchTab('script'); };
        btnTabTools.onClick = function () { switchTab('tools'); };
        btnOpenExprBuilder.onClick = function () { switchTab('expr'); };
        btnOpenExprTab.onClick = function () { switchTab('expr'); };
        btnTabAgent.onClick = function () {
            // Sync the model display label to whatever is currently saved
            agentModelDisplay.text = apiSettings.activeModel || "ChatGPT";
            switchTab('agent');
            refreshAgentLiveAnalysis();
        };

        // Load saved expressions & scripts
        loadExpressions();
        loadScripts();
        updateScriptList();

        // NOW restore API keys/dropdown after loadExpressions has populated apiSettings
        if (apiSettings.openAIKey) apiGptInput.text = apiSettings.openAIKey;
        if (apiSettings.anthropicKey) apiClaudeInput.text = apiSettings.anthropicKey;
        if (apiSettings.geminiKey) apiGeminiInput.text = apiSettings.geminiKey;
        if (apiSettings.kimiKey) apiKimiInput.text = apiSettings.kimiKey;
        if (apiSettings.openRouterKey) apiOpRouterInput.text = apiSettings.openRouterKey;
        if (apiSettings.groqKey) apiGroqInput.text = apiSettings.groqKey;
        if (apiSettings.cerebrasKey) apiCerebrasInput.text = apiSettings.cerebrasKey;
        if (apiSettings.nimKey) apiNimInput.text = apiSettings.nimKey;
        if (apiSettings.githubKey) apiGithubInput.text = apiSettings.githubKey;
        if (apiSettings.mistralKey) apiMistralInput.text = apiSettings.mistralKey;
        if (apiSettings.customApiKey) apiCustomKeyInput.text = apiSettings.customApiKey;
        if (apiSettings.customEndpointUrl) apiCustomUrlInput.text = apiSettings.customEndpointUrl;
        if (apiSettings.customModel) apiCustomModelInput.text = apiSettings.customModel;

        currentGroupFilter = uiState.lastGroupFilter || currentGroupFilter || "All Groups";
        currentSortMode = uiState.lastSortMode || currentSortMode || "Most Used";
        currentTagFilter = uiState.lastTagFilter || currentTagFilter || "All";

        if (!selectDropdownValue(groupDropdown, currentGroupFilter)) {
            groupDropdown.selection = 0;
            currentGroupFilter = groupDropdown.selection ? groupDropdown.selection.text : "All Groups";
        }
        if (!selectDropdownValue(sortDropdown, currentSortMode)) {
            sortDropdown.selection = 0;
            currentSortMode = sortDropdown.selection ? sortDropdown.selection.text : "Most Used";
        }
        setTagFilter(currentTagFilter, true);
        uiState.lastGroupFilter = currentGroupFilter;
        uiState.lastSortMode = currentSortMode;
        uiState.lastTagFilter = currentTagFilter;

        searchInput.text = uiState.lastSearchQuery || "";

        var modIdx = 0;
        var actMod = uiState.selectedModel || apiSettings.activeModel;
        if (actMod === "Claude") modIdx = 1;
        if (actMod === "Gemini") modIdx = 2;
        if (actMod === "Kimi") modIdx = 3;
        if (actMod === "OpenRouter") modIdx = 4;
        if (actMod === "Groq") modIdx = 5;
        if (actMod === "Cerebras") modIdx = 6;
        if (actMod === "NVIDIA NIM") modIdx = 7;
        if (actMod === "GitHub Models") modIdx = 8;
        if (actMod === "Mistral") modIdx = 9;
        if (actMod === "Custom Endpoint") modIdx = 10;
        apiDropdown.selection = modIdx;
        apiSettings.activeModel = apiDropdown.selection ? apiDropdown.selection.text : "ChatGPT";
        uiState.selectedModel = apiSettings.activeModel;
        if (typeof updateApiVisibility === "function") updateApiVisibility();
        setApiStatus("Idle");

        cbAgentPreviewPlan.value = (uiState.agentPlanPreviewEnabled !== false);
        cbAgentPersistentLog.value = (uiState.agentPersistentLoggingEnabled !== false);
        cbFatherMoneyMode.value = (uiState.agentFathersMoneyModeEnabled === true);

        editGroup.visible = !!uiState.expressionEditorOpen;
        toggleEditBtn.updateText(editGroup.visible ? "HIDE EDITOR" : "⊞ ADD NEW EXPRESSION");
        scEditGroup.visible = !!uiState.scriptEditorOpen;
        toggleScEditBtn.updateText(scEditGroup.visible ? "HIDE EDITOR" : "⊞ ADD NEW SCRIPT");

        updateExpressionList(expressionList, searchInput.text, currentGroupFilter, countLabel);
        if (expressionList.items.length === 0 && expressionLibrary.length > 0 && (searchInput.text || "") === "") {
            currentGroupFilter = "All Groups";
            currentSortMode = "Most Used";
            uiState.lastGroupFilter = currentGroupFilter;
            uiState.lastSortMode = currentSortMode;
            selectDropdownValue(groupDropdown, currentGroupFilter);
            selectDropdownValue(sortDropdown, currentSortMode);
            setTagFilter("All", true);
            updateExpressionList(expressionList, "", currentGroupFilter, countLabel);
            saveExpressions();
        }
        switchTab(uiState.lastTab || 'expr');
        refreshAgentLiveAnalysis();

        // Search functionality
        var _lastSearchRefreshTs = 0;
        searchInput.onChanging = function () {
            var nowTs = (new Date()).getTime();
            if ((nowTs - _lastSearchRefreshTs) < 300) return;
            _lastSearchRefreshTs = nowTs;
            uiState.lastSearchQuery = searchInput.text || "";
            updateExpressionList(expressionList, searchInput.text, currentGroupFilter, countLabel);
        };
        searchInput.onChange = function () {
            uiState.lastSearchQuery = searchInput.text || "";
        };
        searchClearBtn.onClick = function () {
            searchInput.text = "";
            uiState.lastSearchQuery = "";
            updateExpressionList(expressionList, "", currentGroupFilter, countLabel);
        };

        // Filters + sorting
        groupDropdown.onChange = function () {
            currentGroupFilter = groupDropdown.selection.text;
            uiState.lastGroupFilter = currentGroupFilter;
            updateExpressionList(expressionList, searchInput.text, currentGroupFilter, countLabel);
        };

        sortDropdown.onChange = function () {
            currentSortMode = sortDropdown.selection ? sortDropdown.selection.text : "Most Used";
            uiState.lastSortMode = currentSortMode;
            updateExpressionList(expressionList, searchInput.text, currentGroupFilter, countLabel);
        };

        for (var tbi = 0; tbi < tagButtons.length; tbi++) {
            (function (tagBtn) {
                tagBtn.onClick = function () {
                    setTagFilter(tagBtn._tagKey, false);
                    updateExpressionList(expressionList, searchInput.text, currentGroupFilter, countLabel);
                };
            })(tagButtons[tbi]);
        };

        // Toggle edit panel visibility
        toggleEditBtn.onClick = function () {
            editGroup.visible = !editGroup.visible;
            uiState.expressionEditorOpen = editGroup.visible;
            if (editGroup.visible) {
                toggleEditBtn.updateText("HIDE EDITOR");
                clearEditFields();
                isEditMode = false;
                editingIndex = -1;
                saveBtn.visible = true;
                updateBtn.visible = false;
            } else {
                toggleEditBtn.updateText("⊞ ADD NEW EXPRESSION");
            }
            applyResponsiveSizing();
            win.layout.layout(true);
            win.layout.resize();
        };

        // When user clicks an expression in the list, show it in the editor
        expressionList.onChange = function () {
            var selectedIndex = expressionList.selection ? expressionList.selection.index : -1;
            if (selectedIndex >= 0 && filteredIndices[selectedIndex] !== undefined) {
                var actualIndex = filteredIndices[selectedIndex];
                var expr = expressionLibrary[actualIndex];

                // Show edit panel if hidden
                if (!editGroup.visible) {
                    editGroup.visible = true;
                    uiState.expressionEditorOpen = true;
                    toggleEditBtn.updateText("HIDE EDITOR");
                    applyResponsiveSizing();
                    win.layout.layout(true);
                    win.layout.resize();
                }

                // Populate fields
                nameInput.text = expr.name;
                descInput.text = expr.description || "";
                exprInput.text = expr.expression;

                // Set category dropdown if matching existing group, else keep unassigned
                var grp = expr.group || "Utility & Workflow";
                for (var i = 0; i < editGroupDropdown.items.length; i++) {
                    if (editGroupDropdown.items[i].text === grp) {
                        editGroupDropdown.selection = i;
                        break;
                    }
                }

                // Set target property dropdown
                var targetProp = expr.targetProperty || "Any Property (Manual)";
                for (var i = 0; i < targetDropdown.items.length; i++) {
                    if (targetDropdown.items[i].text === targetProp) {
                        targetDropdown.selection = i;
                        break;
                    }
                }

                // Switch to edit mode
                isEditMode = true;
                editingIndex = actualIndex;
                saveBtn.visible = false;
                updateBtn.visible = true;
            }
        };

        // Event Handlers
        function applySelectedExpressionFromList() {
            var selectedIndex = expressionList.selection ? expressionList.selection.index : -1;
            if (selectedIndex >= 0 && filteredIndices[selectedIndex] !== undefined) {
                var exprObj = expressionLibrary[filteredIndices[selectedIndex]];
                var beforeUsage = exprObj.usageCount || 0;
                applyExpression(exprObj);
                var appliedNow = (exprObj.usageCount || 0) - beforeUsage;
                if (appliedNow > 0) {
                    appendHistory("Applied expression '" + exprObj.name + "' to " + appliedNow + " property(s)");
                }
            } else {
                alert("Please select an expression from the list first.");
            }
        }

        applyBtn.onClick = function () {
            applySelectedExpressionFromList();
        };

        clearBtn.onClick = function () {
            app.beginUndoGroup("Clear Expression");
            try {
                var comp = app.project.activeItem;
                if (!(comp instanceof CompItem)) { app.endUndoGroup(); return; }

                var selectedProps = comp.selectedProperties;
                var selectedLayers = comp.selectedLayers;
                var clearedCount = 0;

                if (selectedProps.length > 0) {
                    for (var i = 0; i < selectedProps.length; i++) {
                        if (selectedProps[i].canSetExpression && selectedProps[i].expression !== "") {
                            selectedProps[i].expression = "";
                            clearedCount++;
                        }
                    }
                } else if (selectedLayers.length > 0) {
                    alert("Please select the specific properties you want to clear on the timeline. Selecting just the layer is too broad for clearing.");
                    app.endUndoGroup();
                    return;
                }

                if (clearedCount === 0) {
                    alert("No expressions found to clear on selected properties.");
                } else {
                    appendHistory("Cleared " + clearedCount + " expression(s) from selected properties");
                }
            } catch (e) {
                alert("Error clearing expression: " + e.toString());
            }
            app.endUndoGroup();
        };

        // Recursive function to strip expressions off all valid properties within a property group
        function recursiveClearExpressions(propGroup) {
            var cleared = 0;
            for (var i = 1; i <= propGroup.numProperties; i++) {
                var prop = propGroup.property(i);
                if (prop.propertyType === PropertyType.PROPERTY) {
                    if (prop.canSetExpression && prop.expression !== "") {
                        prop.expression = "";
                        cleared++;
                    }
                } else if (prop.propertyType === PropertyType.INDEXED_GROUP || prop.propertyType === PropertyType.NAMED_GROUP) {
                    cleared += recursiveClearExpressions(prop); // Traverse deeper
                }
            }
            return cleared;
        }

        clearLayersBtn.onClick = function () {
            app.beginUndoGroup("Clear ALL Layer Expressions");
            try {
                var comp = app.project.activeItem;
                if (!(comp instanceof CompItem)) { app.endUndoGroup(); return; }

                var selectedLayers = comp.selectedLayers;
                if (selectedLayers.length === 0) {
                    alert("Please select at least one layer to strip all expressions from.");
                    app.endUndoGroup();
                    return;
                }

                // Protect 3rd party plugins!
                var removeEffects = confirm("Do you also want to remove all Expression Control sliders/checkboxes from these layers?\n\n(Click NO if you have other plugins that rely on them).");

                var totalCleared = 0;
                var fxCleared = 0;
                for (var l = 0; l < selectedLayers.length; l++) {
                    var layer = selectedLayers[l];
                    totalCleared += recursiveClearExpressions(layer);

                    if (removeEffects) {
                        var effectsGroup = layer.property("ADBE Effect Parade");
                        if (effectsGroup) {
                            for (var i = effectsGroup.numProperties; i >= 1; i--) {
                                var effect = effectsGroup.property(i);
                                var matchName = effect.matchName;
                                if (matchName === "ADBE Slider Control" ||
                                    matchName === "ADBE Color Control" ||
                                    matchName === "ADBE Checkbox Control" ||
                                    matchName === "ADBE Angle Control" ||
                                    matchName === "ADBE Point3D Control" ||
                                    matchName === "ADBE Point Control" ||
                                    matchName === "ADBE Layer Control" ||
                                    matchName === "ADBE Dropdown Control") {
                                    effect.remove();
                                    fxCleared++;
                                }
                            }
                        }
                    }
                }

                if (totalCleared > 0 || fxCleared > 0) {
                    appendHistory("Stripped " + totalCleared + " expression(s) and " + fxCleared + " controls from selected layers");
                    alert("Success! Cleared " + totalCleared + " expressions and " + fxCleared + " expression controls.");
                } else {
                    alert("No expressions or controls found to clear on the selected layers.");
                }

            } catch (e) {
                alert("Error stripping layer expressions: " + e.toString());
            }
            app.endUndoGroup();
        };

        moveUpBtn.onClick = function () {
            var selectedIndex = expressionList.selection ? expressionList.selection.index : -1;
            if (selectedIndex > 0 && filteredIndices[selectedIndex] !== undefined) {
                var actualIndex = filteredIndices[selectedIndex];
                var prevIndex = filteredIndices[selectedIndex - 1]; // Find visual predecessor
                if (actualIndex > 0 && prevIndex !== undefined) {
                    // Swap in true library
                    var temp = expressionLibrary[actualIndex];
                    expressionLibrary[actualIndex] = expressionLibrary[prevIndex];
                    expressionLibrary[prevIndex] = temp;
                    if (editingIndex === actualIndex) editingIndex = prevIndex;
                    else if (editingIndex === prevIndex) editingIndex = actualIndex;

                    updateExpressionList(expressionList, searchInput ? searchInput.text : "", currentGroupFilter, countLabel);
                    saveExpressions();
                    expressionList.selection = selectedIndex - 1; // Keep selection
                    appendHistory("Moved expression up: " + expressionLibrary[prevIndex].name);
                }
            }
        };

        moveDownBtn.onClick = function () {
            var selectedIndex = expressionList.selection ? expressionList.selection.index : -1;
            if (selectedIndex >= 0 && selectedIndex < filteredIndices.length - 1 && filteredIndices[selectedIndex] !== undefined) {
                var actualIndex = filteredIndices[selectedIndex];
                var nextIndex = filteredIndices[selectedIndex + 1]; // Find visual successor
                if (actualIndex < expressionLibrary.length - 1 && nextIndex !== undefined) {
                    // Swap in true library
                    var temp = expressionLibrary[actualIndex];
                    expressionLibrary[actualIndex] = expressionLibrary[nextIndex];
                    expressionLibrary[nextIndex] = temp;
                    if (editingIndex === actualIndex) editingIndex = nextIndex;
                    else if (editingIndex === nextIndex) editingIndex = actualIndex;

                    updateExpressionList(expressionList, searchInput ? searchInput.text : "", currentGroupFilter, countLabel);
                    saveExpressions();
                    expressionList.selection = selectedIndex + 1; // Keep selection
                    appendHistory("Moved expression down: " + expressionLibrary[nextIndex].name);
                }
            }
        };

        deleteBtn.onClick = function () {
            var selectedIndex = expressionList.selection ? expressionList.selection.index : -1;
            if (selectedIndex >= 0 && filteredIndices[selectedIndex] !== undefined) {
                var actualIndex = filteredIndices[selectedIndex];
                if (confirm("Delete expression '" + expressionLibrary[actualIndex].name + "'?")) {
                    var deletedExprName = expressionLibrary[actualIndex].name;
                    expressionLibrary.splice(actualIndex, 1);
                    updateExpressionList(expressionList, searchInput ? searchInput.text : "", currentGroupFilter, countLabel);
                    saveExpressions();
                    clearEditFields();
                    isEditMode = false;
                    editingIndex = -1;
                    saveBtn.visible = true;
                    updateBtn.visible = false;
                    editGroup.visible = false;
                    uiState.expressionEditorOpen = false;
                    appendHistory("Deleted expression: " + deletedExprName);
                    toggleEditBtn.updateText("⊞ ADD NEW EXPRESSION");
                    applyResponsiveSizing();
                    win.layout.layout(true);
                    win.layout.resize();
                }
            } else {
                alert("Please select an expression to delete.");
            }
        };

        // Duplicate button handler (#10)
        duplicateBtn.onClick = function () {
            var selectedIndex = expressionList.selection ? expressionList.selection.index : -1;
            if (selectedIndex >= 0 && filteredIndices[selectedIndex] !== undefined) {
                var actualIndex = filteredIndices[selectedIndex];
                var orig = expressionLibrary[actualIndex];
                var dup = {
                    name: orig.name + " (Copy)",
                    expression: orig.expression,
                    description: orig.description || "",
                    targetProperty: orig.targetProperty || "Any Property (Manual)",
                    group: orig.group || "Utility & Workflow",
                    createdAt: (new Date()).getTime(),
                    usageCount: 0,
                    lastUsedAt: 0
                };
                if (orig.favorite) dup.favorite = false; // Don't copy favorite status
                expressionLibrary.push(dup);
                saveExpressions();
                updateExpressionList(expressionList, searchInput.text, currentGroupFilter, countLabel);
                appendHistory("Duplicated expression: " + orig.name);
            } else {
                alert("Please select an expression to duplicate.");
            }
        };

        // Favorite toggle button handler (#2)
        favBtn.onClick = function () {
            var selectedIndex = expressionList.selection ? expressionList.selection.index : -1;
            if (selectedIndex >= 0 && filteredIndices[selectedIndex] !== undefined) {
                var actualIndex = filteredIndices[selectedIndex];
                expressionLibrary[actualIndex].favorite = !expressionLibrary[actualIndex].favorite;
                saveExpressions();
                updateExpressionList(expressionList, searchInput.text, currentGroupFilter, countLabel);
                appendHistory("Favorite toggled: " + expressionLibrary[actualIndex].name + " -> " + (expressionLibrary[actualIndex].favorite ? "ON" : "OFF"));
            } else {
                alert("Please select an expression to favorite.");
            }
        };

        saveBtn.onClick = function () {
            if (nameInput.text === "" || exprInput.text === "") {
                alert("Please enter both a name and expression code.");
                return;
            }

            var newExpr = {
                name: nameInput.text,
                expression: exprInput.text,
                description: descInput.text,
                targetProperty: targetDropdown.selection ? targetDropdown.selection.text : "Any Property (Manual)",
                group: editGroupDropdown.selection ? editGroupDropdown.selection.text : "Utility & Workflow",
                createdAt: (new Date()).getTime(),
                usageCount: 0,
                lastUsedAt: 0
            };

            expressionLibrary.push(newExpr);
            updateExpressionList(expressionList, searchInput ? searchInput.text : "", currentGroupFilter, countLabel);
            saveExpressions();
            appendHistory("Saved expression: " + newExpr.name);

            // Clear fields and hide panel
            clearEditFields();
            editGroup.visible = false;
            uiState.expressionEditorOpen = false;
            toggleEditBtn.updateText("⊞ ADD NEW EXPRESSION");
            applyResponsiveSizing();
            win.layout.layout(true);
            win.layout.resize();
        };

        updateBtn.onClick = function () {
            if (nameInput.text === "" || exprInput.text === "") {
                alert("Please enter both a name and expression code.");
                return;
            }

            if (editingIndex >= 0 && editingIndex < expressionLibrary.length) {
                // Preserve existing properties like 'favorite' that aren't in the editor
                var wasFavorite = expressionLibrary[editingIndex].favorite || false;
                var prevCreatedAt = expressionLibrary[editingIndex].createdAt || (new Date()).getTime();
                var prevUsage = expressionLibrary[editingIndex].usageCount || 0;
                var prevLastUsed = expressionLibrary[editingIndex].lastUsedAt || 0;
                expressionLibrary[editingIndex] = {
                    name: nameInput.text,
                    expression: exprInput.text,
                    description: descInput.text,
                    targetProperty: targetDropdown.selection ? targetDropdown.selection.text : "Any Property (Manual)",
                    group: editGroupDropdown.selection ? editGroupDropdown.selection.text : "Utility & Workflow",
                    favorite: wasFavorite,
                    createdAt: prevCreatedAt,
                    usageCount: prevUsage,
                    lastUsedAt: prevLastUsed
                };

                updateExpressionList(expressionList, searchInput ? searchInput.text : "", currentGroupFilter, countLabel);
                saveExpressions();
                appendHistory("Updated expression: " + nameInput.text);

                // Clear fields and reset mode
                clearEditFields();
                isEditMode = false;
                editingIndex = -1;
                saveBtn.visible = true;
                updateBtn.visible = false;
                editGroup.visible = false;
                uiState.expressionEditorOpen = false;
                toggleEditBtn.updateText("⊞ ADD NEW EXPRESSION");
                applyResponsiveSizing();
                win.layout.layout(true);
                win.layout.resize();
            }
        };

        cancelBtn.onClick = function () {
            clearEditFields();
            isEditMode = false;
            editingIndex = -1;
            saveBtn.visible = true;
            updateBtn.visible = false;
            editGroup.visible = false;
            uiState.expressionEditorOpen = false;
            toggleEditBtn.updateText("⊞ ADD NEW EXPRESSION");
            applyResponsiveSizing();
            win.layout.layout(true);
            win.layout.resize();
        };

        // Double-click to apply
        expressionList.onDoubleClick = function () {
            applySelectedExpressionFromList();
        };

        // ==========================================
        // SCRIPTS TAB EVENT HANDLERS
        // ==========================================
        function updateScriptList() {
            scriptList.removeAll();
            for (var i = 0; i < scriptLibrary.length; i++) {
                scriptList.add("item", scriptLibrary[i].name);
            }
        }

        function clearScEditFields() {
            scNameInput.text = "";
            scDescInput.text = "";
            scCodeInput.text = "";
        }

        toggleScEditBtn.onClick = function () {
            scEditGroup.visible = !scEditGroup.visible;
            uiState.scriptEditorOpen = scEditGroup.visible;
            if (scEditGroup.visible) {
                toggleScEditBtn.updateText("HIDE EDITOR");
                clearScEditFields();
                isScEditMode = false;
                editingScIndex = -1;
                saveScBtn.visible = true;
                updateScBtn.visible = false;
            } else { toggleScEditBtn.updateText("⊞ ADD NEW SCRIPT"); }
            applyResponsiveSizing();
            win.layout.layout(true); win.layout.resize();
        };

        saveScBtn.onClick = function () {
            if (scNameInput.text === "" || scCodeInput.text === "") { alert("Please enter a name and script code."); return; }
            scriptLibrary.push({ name: scNameInput.text, description: scDescInput.text, script: scCodeInput.text });
            updateScriptList(); saveScripts(); clearScEditFields();
            appendHistory("Saved script: " + scNameInput.text);
            uiState.scriptEditorOpen = false;
            scEditGroup.visible = false; toggleScEditBtn.updateText("⊞ ADD NEW SCRIPT");
            win.layout.layout(true); win.layout.resize();
        };

        updateScBtn.onClick = function () {
            if (scNameInput.text === "" || scCodeInput.text === "") return;
            if (editingScIndex >= 0 && editingScIndex < scriptLibrary.length) {
                scriptLibrary[editingScIndex] = { name: scNameInput.text, description: scDescInput.text, script: scCodeInput.text };
                updateScriptList(); saveScripts(); clearScEditFields();
                appendHistory("Updated script: " + scNameInput.text);
                isScEditMode = false; editingScIndex = -1;
                saveScBtn.visible = true; updateScBtn.visible = false;
                uiState.scriptEditorOpen = false;
                scEditGroup.visible = false;
                toggleScEditBtn.updateText("⊞ ADD NEW SCRIPT");
                win.layout.layout(true); win.layout.resize();
            }
        };

        cancelScBtn.onClick = function () {
            clearScEditFields();
            isScEditMode = false; editingScIndex = -1;
            saveScBtn.visible = true; updateScBtn.visible = false;
            uiState.scriptEditorOpen = false;
            scEditGroup.visible = false; toggleScEditBtn.updateText("⊞ ADD NEW SCRIPT");
            win.layout.layout(true); win.layout.resize();
        };

        editScBtn.onClick = function () {
            var sel = scriptList.selection ? scriptList.selection.index : -1;
            if (sel >= 0 && sel < scriptLibrary.length) {
                if (!scEditGroup.visible) {
                    scEditGroup.visible = true;
                    uiState.scriptEditorOpen = true;
                    toggleScEditBtn.updateText("HIDE EDITOR");
                    applyResponsiveSizing();
                    win.layout.layout(true); win.layout.resize();
                }
                var sc = scriptLibrary[sel];
                scNameInput.text = sc.name; scDescInput.text = sc.description || ""; scCodeInput.text = sc.script;
                isScEditMode = true; editingScIndex = sel;
                saveScBtn.visible = false; updateScBtn.visible = true;
            } else { alert("Please select a script to edit."); }
        };

        delScBtn.onClick = function () {
            var sel = scriptList.selection ? scriptList.selection.index : -1;
            if (sel >= 0) {
                if (confirm("Delete script '" + scriptLibrary[sel].name + "'?")) {
                    appendHistory("Deleted script: " + scriptLibrary[sel].name);
                    scriptLibrary.splice(sel, 1);
                    updateScriptList(); saveScripts(); clearScEditFields();
                    isScEditMode = false; editingScIndex = -1; saveScBtn.visible = true; updateScBtn.visible = false;
                }
            } else { alert("Please select a script to delete."); }
        };

        // EXTENDSCRIPT EXECUTION ENGINE
        runScBtn.onClick = function () {
            var sel = scriptList.selection ? scriptList.selection.index : -1;
            if (sel >= 0 && sel < scriptLibrary.length) {
                var scriptContent = scriptLibrary[sel].script;
                if (!confirm("WARNING: Executing scripts grants them full access to After Effects and your computer. Only run scripts you trust. Proceed?")) return;
                if (containsRiskyScriptOps(scriptContent) &&
                    !confirm("High-risk operations were detected in this script (file/system/project actions).\nRun anyway?")) return;
                app.beginUndoGroup(scriptLibrary[sel].name);
                var tempScript = null;
                try {
                    // Write to temp file to force GLOBAL scope execution
                    tempScript = new File(Folder.temp.fullName + "/balongra_temp_run.jsx");
                    tempScript.encoding = "UTF-8";
                    tempScript.open("w");
                    tempScript.write(scriptContent);
                    tempScript.close();
                    $.evalFile(tempScript);
                    appendHistory("Script executed: " + scriptLibrary[sel].name);
                } catch (e) {
                    appendHistory("Script failed: " + scriptLibrary[sel].name + " (" + e.toString().substr(0, 80) + ")");
                    alert("Script Error:\n" + e.toString());
                } finally {
                    try { if (tempScript && tempScript.exists) tempScript.remove(); } catch (x) { }
                }
                app.endUndoGroup();
            } else { alert("Please select a script to run."); }
        };

        scriptList.onDoubleClick = function () { runScBtn.onClick(); };

        function performAutoSave() {
            if (editGroup.visible && isEditMode === true && editingIndex >= 0 && editingIndex < expressionLibrary.length) {
                expressionLibrary[editingIndex].name = nameInput.text;
                expressionLibrary[editingIndex].expression = exprInput.text;
                expressionLibrary[editingIndex].description = descInput.text;
                expressionLibrary[editingIndex].targetProperty = targetDropdown.selection ? targetDropdown.selection.text : "Any Property (Manual)";
                expressionLibrary[editingIndex].group = editGroupDropdown.selection ? editGroupDropdown.selection.text : "Utility & Workflow";
            }
        }
        nameInput.onChange = performAutoSave;
        exprInput.onChange = performAutoSave;
        descInput.onChange = performAutoSave;
        targetDropdown.onChange = performAutoSave;
        editGroupDropdown.onChange = performAutoSave;

        // Auto-save on window close — with confirm for unsaved NEW expressions (#3)
        win.onClose = function () {
            performAutoSave();
            uiState.expressionEditorOpen = !!editGroup.visible;
            uiState.scriptEditorOpen = !!scEditGroup.visible;
            uiState.lastSearchQuery = searchInput.text || "";
            uiState.lastGroupFilter = currentGroupFilter;
            uiState.lastSortMode = currentSortMode;
            uiState.lastTagFilter = currentTagFilter;
            uiState.selectedModel = apiDropdown.selection ? apiDropdown.selection.text : (apiSettings.activeModel || "ChatGPT");
            // If adding a NEW expression (editor visible, fields filled, but not in edit mode)
            if (editGroup.visible && !isEditMode && nameInput.text !== "") {
                var saveNew = confirm("You have an unsaved new expression ('" + nameInput.text + "').\nWould you like to save it before closing?");
                if (saveNew && exprInput.text !== "") {
                    expressionLibrary.push({
                        name: nameInput.text,
                        expression: exprInput.text,
                        description: descInput.text,
                        targetProperty: targetDropdown.selection ? targetDropdown.selection.text : "Any Property (Manual)",
                        group: editGroupDropdown.selection ? editGroupDropdown.selection.text : "Utility & Workflow",
                        createdAt: (new Date()).getTime(),
                        usageCount: 0,
                        lastUsedAt: 0
                    });
                }
            }
            saveExpressions();
        };

        // Helper function to clear edit fields
        function clearEditFields() {
            nameInput.text = "";
            descInput.text = "";
            exprInput.text = "";
            targetDropdown.selection = 0;
            editGroupDropdown.selection = 0;
        }

        var _resizeGuard = false;
        var _resizeLastTs = 0;
        win.onResizing = win.onResize = function () {
            // Debounce: skip redundant layouts fired within 80ms of each other
            var nowTs = (new Date()).getTime();
            if (_resizeGuard || (nowTs - _resizeLastTs) < 80) return;
            _resizeGuard = true;
            _resizeLastTs = nowTs;
            try {
                applyResponsiveSizing();
                win.layout.layout(true);
            } catch (rzErr) { }
            _resizeGuard = false;
        };

        applyResponsiveSizing();
        win.layout.layout(true);
        win.layout.resize();

        // ── Engraved footer ──────────────────────────────────────
        var footerGroup = win.add("group");
        footerGroup.orientation = "row";
        footerGroup.alignment = ["fill", "bottom"];
        footerGroup.alignChildren = ["center", "center"];
        footerGroup.margins = [0, 2, 0, 4];

        var footerText = footerGroup.add("statictext", undefined, "\u2015\u2015  Balongra AI agent  \u00b7  made with \u2665 by Asif Gondal  \u2015\u2015");
        footerText.alignment = ["center", "center"];
        footerText.graphics.foregroundColor = footerText.graphics.newPen(
            footerText.graphics.PenType.SOLID_COLOR, [0.25, 0.25, 0.28], 1);
        try {
            footerText.graphics.font = ScriptUI.newFont("Arial", "REGULAR", 9);
        } catch (fe) {}

        win.layout.layout(true);
        return win;
    }

    function ensureExpressionMeta(expr) {
        if (!expr) return;
        if (expr.createdAt === undefined || expr.createdAt === null || expr.createdAt === "") expr.createdAt = (new Date()).getTime();
        if (expr.usageCount === undefined || expr.usageCount === null || isNaN(expr.usageCount)) expr.usageCount = 0;
        if (expr.lastUsedAt === undefined || expr.lastUsedAt === null) expr.lastUsedAt = 0;
    }

    // Helper function to auto-detect what an expression does
    function detectTags(exprStr, exprName, targetProp) {
        var tags = [];
        var s = (exprStr || "").toLowerCase();
        var n = (exprName || "").toLowerCase();
        var t = (targetProp || "").toLowerCase();

        if (s.indexOf("wiggle") !== -1 || s.indexOf("bounce") !== -1 || s.indexOf("elastic") !== -1 || n.indexOf("animation") !== -1) tags.push("Motion");
        if (t.indexOf("source text") !== -1 || n.indexOf("text") !== -1 || n.indexOf("counter") !== -1 || s.indexOf("sourceText") !== -1) tags.push("Text");
        if (s.indexOf("loopout") !== -1 || s.indexOf("loopin") !== -1 || n.indexOf("loop") !== -1 || s.indexOf("valueattime") !== -1) tags.push("Loop");
        if (s.indexOf("math.") !== -1 || s.indexOf("ease") !== -1 || s.indexOf("linear") !== -1 || s.indexOf("sin") !== -1 || s.indexOf("cos") !== -1) tags.push("Math");
        if (s.indexOf("index") !== -1 || s.indexOf("clamp") !== -1 || n.indexOf("utility") !== -1 || n.indexOf("workflow") !== -1) tags.push("Utility");

        if (tags.length === 0) tags.push("Utility");
        return tags;
    }

    function fuzzySubsequenceMatch(text, query) {
        if (!query || query === "") return true;
        var t = (text || "").toLowerCase();
        var q = (query || "").toLowerCase();
        if (t.indexOf(q) !== -1) return true;
        var qi = 0;
        for (var i = 0; i < t.length && qi < q.length; i++) {
            if (t.charAt(i) === q.charAt(qi)) qi++;
        }
        return qi === q.length;
    }

    // Update the expression list UI
    function updateExpressionList(listbox, searchQuery, groupFilter, countLabelRef) {
        if (listbox.parent) listbox.parent.layout.layout(false);
        var wasVisible = listbox.visible;
        listbox.visible = false;
        
        listbox.removeAll();
        filteredIndices = [];

        var query = (searchQuery || "").toLowerCase();
        var gFilter = groupFilter || "All Groups";
        var sortMode = currentSortMode || "Most Used";
        var tagFilter = currentTagFilter || "All";
        var matches = [];

        for (var i = 0; i < expressionLibrary.length; i++) {
            var expr = expressionLibrary[i];
            ensureExpressionMeta(expr);

            // Favorites filter
            if (gFilter === "\u2605 Favorites") {
                if (!expr.favorite) continue;
            } else if (gFilter !== "All Groups" && expr.group !== gFilter) {
                continue;
            }

            var tags = detectTags(expr.expression, expr.name, expr.targetProperty);
            if (tagFilter !== "All") {
                var hasTag = false;
                for (var tg = 0; tg < tags.length; tg++) {
                    if (tags[tg] === tagFilter) { hasTag = true; break; }
                }
                if (!hasTag) continue;
            }

            var searchableText = (expr.name + " " + (expr.description || "") + " " + (expr.targetProperty || "") + " " + tags.join(" ")).toLowerCase();
            if (!fuzzySubsequenceMatch(searchableText, query)) continue;

            var score = 0;
            if (query !== "") {
                if (expr.name.toLowerCase().indexOf(query) !== -1) score += 4;
                if ((expr.description || "").toLowerCase().indexOf(query) !== -1) score += 2;
                if ((expr.targetProperty || "").toLowerCase().indexOf(query) !== -1) score += 1;
            }
            score += (expr.usageCount || 0) * 0.05;

            matches.push({ idx: i, score: score, tags: tags });
        }

        matches.sort(function (a, b) {
            var ea = expressionLibrary[a.idx];
            var eb = expressionLibrary[b.idx];

            if (sortMode === "A-Z") {
                return ea.name.toLowerCase() > eb.name.toLowerCase() ? 1 : -1;
            } else if (sortMode === "Recently Added") {
                return (eb.createdAt || 0) - (ea.createdAt || 0);
            }

            // Default: Most Used
            if ((eb.usageCount || 0) !== (ea.usageCount || 0)) return (eb.usageCount || 0) - (ea.usageCount || 0);
            if ((eb.lastUsedAt || 0) !== (ea.lastUsedAt || 0)) return (eb.lastUsedAt || 0) - (ea.lastUsedAt || 0);
            return b.score - a.score;
        });

        for (var m = 0; m < matches.length; m++) {
            var exprObj = expressionLibrary[matches[m].idx];
            var displayName = exprObj.favorite ? "\u2605 " + exprObj.name : exprObj.name;
            var item = listbox.add("item", displayName);
            item.subItems[0].text = exprObj.targetProperty || "Any Property";
            filteredIndices.push(matches[m].idx);
        }

        listbox.visible = wasVisible;
        if (listbox.parent) listbox.parent.layout.layout(true);

        if (countLabelRef) {
            countLabelRef.text = "Showing " + filteredIndices.length + " of " + expressionLibrary.length + "  //  Sort: " + sortMode + "  //  Tag: " + tagFilter;
        }
    }

    // ==========================================
    // SMART AUTO-RIGGING SYSTEM
    // ==========================================
    function rigNormalizeNameKey(name) {
        return String(name || "").toLowerCase().replace(/["'`]/g, "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    }

    function inferControlMatchName(propertyToken, effectName) {
        var token = String(propertyToken !== undefined ? propertyToken : "").toLowerCase();
        var eLow = String(effectName || "").toLowerCase();

        if (token === "") {
            if (eLow.indexOf("color") !== -1 || eLow.indexOf("colour") !== -1) return "ADBE Color Control";
            if (eLow.indexOf("checkbox") !== -1 || eLow.indexOf("toggle") !== -1 || eLow.indexOf("enable") !== -1) return "ADBE Checkbox Control";
            if (eLow.indexOf("angle") !== -1 || eLow.indexOf("rotation") !== -1) return "ADBE Angle Control";
            if (eLow.indexOf("point 3d") !== -1 || eLow.indexOf("3d point") !== -1) return "ADBE Point3D Control";
            if (eLow.indexOf("point") !== -1 || eLow.indexOf("pos") !== -1 || eLow.indexOf("anchor") !== -1) return "ADBE Point Control";
            if (eLow.indexOf("layer") !== -1) return "ADBE Layer Control";
            if (eLow.indexOf("dropdown") !== -1 || eLow.indexOf("menu") !== -1 || eLow.indexOf("mode") !== -1 || eLow.indexOf("select") !== -1) return "ADBE Dropdown Control";
            return "ADBE Slider Control";
        }

        if (/^\d+$/.test(token)) {
            return inferControlMatchName("", effectName);
        }

        if (token.indexOf("slider") !== -1) return "ADBE Slider Control";
        if (token.indexOf("color") !== -1 || token.indexOf("colour") !== -1) return "ADBE Color Control";
        if (token.indexOf("checkbox") !== -1 || token.indexOf("check box") !== -1) return "ADBE Checkbox Control";
        if (token.indexOf("angle") !== -1) return "ADBE Angle Control";
        if (token.indexOf("point 3d") !== -1 || token.indexOf("3d point") !== -1) return "ADBE Point3D Control";
        if (token.indexOf("point") !== -1) return "ADBE Point Control";
        if (token.indexOf("layer") !== -1) return "ADBE Layer Control";
        if (token.indexOf("dropdown") !== -1 || token.indexOf("menu") !== -1) return "ADBE Dropdown Control";
        return "";
    }

    function applyExpressionControlDefault(effectObj, matchName, effectName) {
        if (!effectObj) return;
        try {
            if (matchName === "ADBE Slider Control") {
                var eLower = String(effectName || "").toLowerCase();
                var def = 50;
                if (eLower.indexOf("freq") !== -1 || eLower.indexOf("rate") !== -1 || eLower.indexOf("decay") !== -1 || eLower.indexOf("delay") !== -1) def = 2;
                else if (eLower.indexOf("amp") !== -1 || eLower.indexOf("amount") !== -1 || eLower.indexOf("intensity") !== -1 || eLower.indexOf("mult") !== -1) def = 100;
                else if (eLower.indexOf("speed") !== -1 || eLower.indexOf("rpm") !== -1 || eLower.indexOf("bpm") !== -1) def = 100;
                else if (eLower.indexOf("radius") !== -1 || eLower.indexOf("dist") !== -1 || eLower.indexOf("len") !== -1) def = 300;
                else if (eLower.indexOf("min") !== -1) def = 10;
                else if (eLower.indexOf("max") !== -1 || eLower.indexOf("limit") !== -1) def = 100;
                else if (eLower.indexOf("time") !== -1 || eLower.indexOf("dur") !== -1) def = 1.5;
                else if (eLower.indexOf("chance") !== -1 || eLower.indexOf("prob") !== -1) def = 50;
                else if (eLower.indexOf("step") !== -1 || eLower.indexOf("grid") !== -1) def = 50;
                effectObj.property(1).setValue(def);
            } else if (matchName === "ADBE Checkbox Control") {
                effectObj.property(1).setValue(1);
            }
        } catch (e) { }
    }

    function rigFindEffectByName(effectGroup, effectName, requireMatchName) {
        if (!effectGroup) return null;
        var targetKey = rigNormalizeNameKey(effectName);
        var firstNameMatch = null;
        for (var i = 1; i <= effectGroup.numProperties; i++) {
            var fx = effectGroup.property(i);
            if (!fx) continue;
            if (rigNormalizeNameKey(fx.name) !== targetKey) continue;
            if (!firstNameMatch) firstNameMatch = fx;
            if (requireMatchName && fx.matchName === requireMatchName) return fx;
            if (!requireMatchName) return fx;
        }
        return firstNameMatch;
    }

    function rigUniqueLegacyName(effectGroup, baseName) {
        var candidate = String(baseName || "Control") + " (legacy)";
        var n = 2;
        while (rigFindEffectByName(effectGroup, candidate, null)) {
            candidate = String(baseName || "Control") + " (legacy " + n + ")";
            n++;
            if (n > 99) break;
        }
        return candidate;
    }

    function ensureExpressionControlOnLayer(targetLayer, effectName, propertyToken, options, report) {
        if (!targetLayer) return false;
        var opt = options || {};
        var matchName = inferControlMatchName(propertyToken, effectName);
        if (matchName === "") {
            if (report) report.skipped++;
            return false;
        }

        var effectGroup = targetLayer.property("ADBE Effect Parade");
        if (!effectGroup) {
            if (report) report.skipped++;
            return false;
        }

        var exact = rigFindEffectByName(effectGroup, effectName, matchName);
        if (exact && exact.matchName === matchName) {
            if (report) report.reused++;
            return true;
        }

        var nameMatch = rigFindEffectByName(effectGroup, effectName, null);
        if (nameMatch && nameMatch.matchName !== matchName) {
            var allowRepair = (opt.repairConflicts !== false) || opt.forceResetConflicts === true;
            if (!allowRepair) {
                if (report) report.skipped++;
                return false;
            }
            try {
                nameMatch.name = rigUniqueLegacyName(effectGroup, effectName);
            } catch (renameErr) { }
        }

        try {
            var fx = effectGroup.addProperty(matchName);
            fx.name = effectName;
            applyExpressionControlDefault(fx, matchName, effectName);
            if (report) {
                if (nameMatch && nameMatch.matchName !== matchName) report.repaired++;
                else report.created++;
            }
            return true;
        } catch (addErr) {
            if (report) report.skipped++;
            return false;
        }
    }

    function collectExpressionControlRefs(exprStr) {
        var refs = [];
        var seen = {};
        var expr = String(exprStr || "");

        function addRef(layerName, effectName, propertyToken) {
            var eName = String(effectName || "").replace(/^\s+|\s+$/g, "");
            if (eName === "") return;
            var pTok = (propertyToken !== undefined && propertyToken !== null) ? String(propertyToken).replace(/^\s+|\s+$/g, "") : "";
            var key = rigNormalizeNameKey(layerName || "__self__") + "|" + rigNormalizeNameKey(eName) + "|" + pTok.toLowerCase();
            if (seen[key]) return;
            seen[key] = true;
            refs.push({ layerName: layerName || "", effectName: eName, propertyToken: pTok });
        }

        var layerRegex = /thisComp\s*\.\s*layer\s*\(\s*\\?["'](.*?)\\?["']\s*\)\s*\.\s*effect\s*\(\s*\\?["'](.*?)\\?["']\s*\)\s*\(\s*(?:\\?["'](.*?)\\?["']|(\d+))\s*\)/g;
        var lm;
        while ((lm = layerRegex.exec(expr)) !== null) {
            addRef(lm[1], lm[2], lm[3] !== undefined ? lm[3] : lm[4]);
        }

        var stripped = expr.replace(/thisComp\s*\.\s*layer\s*\(\s*\\?["'].*?\\?["']\s*\)\s*\.\s*effect\s*\(\s*\\?["'].*?\\?["']\s*\)\s*\(\s*(?:\\?["'].*?\\?["']|\d+)\s*\)/g, " ");
        var effectRegex = /effect\s*\(\s*\\?["'](.*?)\\?["']\s*\)\s*\(\s*(?:\\?["'](.*?)\\?["']|(\d+))\s*\)/g;
        var m;
        while ((m = effectRegex.exec(stripped)) !== null) {
            addRef("", m[1], m[2] !== undefined ? m[2] : m[3]);
        }
        return refs;
    }

    function autoRigControls(layer, exprStr, options) {
        var report = { scanned: 0, created: 0, repaired: 0, reused: 0, skipped: 0 };
        if (!exprStr || !layer) return report;

        var refs = collectExpressionControlRefs(exprStr);
        report.scanned = refs.length;
        if (refs.length === 0) return report;

        var comp = null;
        try { comp = layer.containingComp; } catch (ce) { }

        for (var i = 0; i < refs.length; i++) {
            var ref = refs[i];
            var targetLayer = layer;
            if (ref.layerName && ref.layerName !== "" && comp) {
                try { targetLayer = comp.layer(ref.layerName); } catch (fe) { targetLayer = null; }
            }
            ensureExpressionControlOnLayer(targetLayer, ref.effectName, ref.propertyToken, options || {}, report);
        }
        return report;
    }

    // Apply expression to selected property or find it on selected layer
    function applyExpression(exprObj) {
        app.beginUndoGroup("Apply Expression");

        try {
            var comp = app.project.activeItem;
            if (!(comp instanceof CompItem)) {
                alert("Please select a composition first.");
                app.endUndoGroup();
                return;
            }

            var selectedLayers = comp.selectedLayers;
            var selectedProps = comp.selectedProperties;

            if (selectedLayers.length === 0 && selectedProps.length === 0) {
                alert("Please select at least one layer or property in the timeline.");
                app.endUndoGroup();
                return;
            }

            var appliedCount = 0;
            var failedNotes = [];
            var targetPropName = exprObj.targetProperty;

            // If "Any Property (Manual)" is selected, use the old behavior
            if (targetPropName === "Any Property (Manual)") {
                if (selectedProps.length === 0) {
                    alert("For 'Any Property' expressions, please select a specific property in the timeline.");
                    app.endUndoGroup();
                    return;
                }

                for (var i = 0; i < selectedProps.length; i++) {
                    var prop = selectedProps[i];
                    if (prop.canSetExpression) {
                        var rootLayer = prop.propertyGroup(prop.propertyDepth);
                        var applyRes = setExpressionOnPropertySafely(prop, rootLayer, exprObj.expression);
                        if (applyRes.ok) appliedCount++;
                        else failedNotes.push((prop.name || "property") + ": " + applyRes.msg);
                    }
                }
            } else {
                // New behavior: find the target property on selected layers
                for (var i = 0; i < selectedLayers.length; i++) {
                    var layer = selectedLayers[i];
                    var property = findProperty(layer, targetPropName);

                    if (property && property.canSetExpression) {
                        var applyRes = setExpressionOnPropertySafely(property, layer, exprObj.expression);
                        if (applyRes.ok) appliedCount++;
                        else failedNotes.push(layer.name + ": " + applyRes.msg);
                    }
                }

                if (appliedCount === 0 && selectedLayers.length > 0) {
                    alert("Could not find '" + targetPropName + "' property on selected layer(s).");
                    app.endUndoGroup();
                    return;
                }
            }

            if (appliedCount === 0) {
                // Total failure — show all collected error details
                var failHint = "";
                if (failedNotes.length > 0) {
                    var showNotes = failedNotes.slice(0, 4);
                    failHint = "\n\nDetails:\n" + showNotes.join("\n");
                    if (failedNotes.length > 4) failHint += "\n(+" + (failedNotes.length - 4) + " more)";
                }
                alert("No properties could accept the expression." + failHint);
            } else {
                ensureExpressionMeta(exprObj);
                exprObj.usageCount = (exprObj.usageCount || 0) + appliedCount;
                exprObj.lastUsedAt = (new Date()).getTime();
                saveExpressions();
                // Partial failure: applied to some layers but not all — surface the failures
                // so the user knows which layers were skipped and why.
                if (failedNotes.length > 0) {
                    var partialMsg = "Applied to " + appliedCount + " layer(s).\n\nCould not apply to " +
                        failedNotes.length + " layer(s):\n" + failedNotes.slice(0, 5).join("\n");
                    if (failedNotes.length > 5) partialMsg += "\n(+" + (failedNotes.length - 5) + " more)";
                    alert(partialMsg);
                }
            }

        } catch (e) {
            alert("Error applying expression: " + e.toString());
        }

        app.endUndoGroup();
    }

    // Helper function to find a property by name in a layer
    function findProperty(layer, propName) {
        try {
            // Handle special cases
            if (propName === "Rotation X" || propName === "X Rotation") return layer.property("Transform").property("X Rotation");
            if (propName === "Rotation Y" || propName === "Y Rotation") return layer.property("Transform").property("Y Rotation");
            if (propName === "Rotation Z" || propName === "Z Rotation") return layer.property("Transform").property("Z Rotation");
            if (propName === "Time Remap") {
                if (layer.canSetTimeRemapEnabled) {
                    layer.timeRemapEnabled = true;
                }
                return layer.property("Time Remap");
            }

            if (propName === "Source Text" || propName === "sourceText") {
                // Source Text is nested: layer > Text group > Source Text
                try {
                    var textGroup = layer.property("Text") || layer.property("ADBE Text Properties");
                    if (textGroup) {
                        var srcText = textGroup.property("Source Text") || textGroup.property("ADBE Text Document");
                        if (srcText) return srcText;
                    }
                } catch (ste) { }
                // Last-resort: recursive search
                return searchPropertyRecursive(layer, "Source Text") || searchPropertyRecursive(layer, "ADBE Text Document");
            }

            // Try common transform properties first
            var transformGroup = layer.property("Transform");
            if (transformGroup) {
                var transformProp = transformGroup.property(propName);
                if (transformProp) {
                    return transformProp;
                }
            }

            // Try direct property access
            var directProp = layer.property(propName);
            if (directProp) {
                return directProp;
            }

            // For Effects, try to find in Effects group
            if (propName === "Effects (Custom)") {
                var effects = layer.property("Effects");
                if (effects && effects.numProperties > 0) {
                    return effects.property(1).property(1);
                }
            }

            // Search recursively through all properties
            return searchPropertyRecursive(layer, propName);

        } catch (e) {
            return null;
        }
    }

    // Recursive search through property groups
    // ── Stable property path utilities (inspired by Wiggle_Rig.jsx) ──────────────
    // Capture a property's matchName path (array of matchNames from the layer root)
    // so it can be re-fetched AFTER addProperty() calls that invalidate old refs.
    //
    // Usage:
    //   var path = getPropertyPath(prop);          // collect phase
    //   // ... addProperty() calls happen ...
    //   var freshProp = getPropertyByPath(layer, path); // apply phase
    function getPropertyPath(prop) {
        var path = [];
        var current = prop;
        try {
            while (current && current.parentProperty) {
                if (current.matchName) path.unshift(current.matchName);
                current = current.parentProperty;
            }
        } catch (e) {}
        return path;
    }

    function getPropertyByPath(layer, path) {
        var current = layer;
        try {
            for (var i = 0; i < path.length; i++) {
                current = current.property(path[i]);
                if (!current) return null;
            }
        } catch (e) {
            return null;
        }
        return current;
    }
    // ─────────────────────────────────────────────────────────────────────────────

    function searchPropertyRecursive(propGroup, propName) {
        try {
            if (!propGroup || !propGroup.numProperties) {
                return null;
            }

            for (var i = 1; i <= propGroup.numProperties; i++) {
                var prop = propGroup.property(i);

                // Check if this property matches
                if (prop.name === propName || prop.matchName === propName) {
                    return prop;
                }

                // If it's a group, search recursively
                if (prop.numProperties !== undefined && prop.numProperties > 0) {
                    var found = searchPropertyRecursive(prop, propName);
                    if (found) {
                        return found;
                    }
                }
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    // Load expressions from settings file
    function loadExpressions() {
        if (typeof JSON === "undefined") {
            alert("This version of After Effects does not natively support JSON. Settings won't be saved.");
            expressionLibrary = defaultExpressions.slice();
            return;
        }
        var loadFailed = false;
        var settingsFile = null; // declared at function scope — used after try block
        try {
            var settingsFolder = new Folder(Folder.userData.fullName + "/ExpressoSettings");
            settingsFile = new File(settingsFolder.fullName + "/ExpressionManager_Settings.json");

            // Fallback for settings saved by the older version
            var oldSettingsFile = new File(Folder.userData.fsName + "/ExpressionManager_Settings.json");
            if (!settingsFile.exists && oldSettingsFile.exists) {
                settingsFile = oldSettingsFile;
            }

            if (settingsFile.exists) {
                settingsFile.open("r");
                var data = settingsFile.read();
                settingsFile.close();
                var loaded = JSON.parse(data);
                var loadedLibrary = null;
                if (loaded && loaded.library && loaded.library instanceof Array) loadedLibrary = loaded.library;
                else if (loaded instanceof Array) loadedLibrary = loaded;

                // Handle new API settings object saving strategy
                if (loadedLibrary) {
                    expressionLibrary = loadedLibrary;
                    if (loaded.apiSettings) {
                        // Safe merge: copy saved keys into the pre-initialised object.
                        // This preserves defaults for NEW keys not present in old save files,
                        // preventing a complete wipe of provider keys on upgrade.
                        var savedApi = loaded.apiSettings;
                        for (var k in savedApi) {
                            if (savedApi.hasOwnProperty(k)) {
                                apiSettings[k] = savedApi[k];
                            }
                        }
                    }
                    if (loaded.uiState) {
                        for (var uk in loaded.uiState) {
                            if (loaded.uiState.hasOwnProperty(uk)) uiState[uk] = loaded.uiState[uk];
                        }
                    }
                } else {
                    // Corrupt or incompatible save shape; recover safely.
                    expressionLibrary = [];
                }
                // fallthrough
                // Intentionally not returning here so it falls through to auto-categorization
            }
        } catch (e) {
            loadFailed = true;
            alert("Error loading saved expressions: " + e.toString() + "\nLoading defaults instead.");
        }

        // Use default expressions if no saved settings, loading failed, or library is empty
        if (!expressionLibrary || expressionLibrary.length === 0) {
            expressionLibrary = defaultExpressions.slice();

            // Only save defaults to disk if it's a completely new installation or file is corrupt
            if (!settingsFile || !settingsFile.exists || loadFailed) {
                saveExpressions();
            }
        }

        // Auto-categorize any loaded expressions that lack a group
        for (var i = 0; i < expressionLibrary.length; i++) {
            var expr = expressionLibrary[i];
            if (!expr.group || expr.group === "" || expr.group === "undefined") {
                var nm = expr.name.toLowerCase(); var ex = expr.expression.toLowerCase(); var tp = expr.targetProperty ? expr.targetProperty.toLowerCase() : "";
                if (nm.indexOf("bounce") > -1 || nm.indexOf("elastic") > -1 || nm.indexOf("pop") > -1 || nm.indexOf("ui") > -1 || nm.indexOf("scale") > -1) expr.group = "UI & Animation";
                else if (nm.indexOf("time") > -1 || nm.indexOf("loop") > -1 || nm.indexOf("delay") > -1 || nm.indexOf("posterize") > -1) expr.group = "Time & Looping";
                else if (nm.indexOf("text") > -1 || nm.indexOf("counter") > -1 || nm.indexOf("typewriter") > -1 || tp.indexOf("source text") > -1) expr.group = "Text & Counters";
                else if (nm.indexOf("3d") > -1 || nm.indexOf("parallax") > -1 || nm.indexOf("physics") > -1 || nm.indexOf("math") > -1 || nm.indexOf("sine") > -1) expr.group = "3D, Math & Physics";
                else expr.group = "Utility & Workflow";
            }
            ensureExpressionMeta(expr);
        }
    }

    // Save expressions to settings file
    function saveExpressions() {
        if (typeof JSON === "undefined") return; // Fail safely on very old versions
        try {
            var settingsFolder = new Folder(Folder.userData.fullName + "/ExpressoSettings");
            if (!settingsFolder.exists) settingsFolder.create();

            // SECURITY NOTE:
            // Settings are saved ONLY to the current user's private data folder:
            //   Mac:     ~/Library/Application Support/ExpressoSettings/
            //   Windows: %APPDATA%\ExpressoSettings\
            // This file is NEVER embedded in the .jsx plugin file.
            // Sharing balongraaa.jsx with other users does NOT share your API keys.
            // The keys stored here are NOT encrypted — do not store keys on shared machines.

            var settingsFile = new File(settingsFolder.fullName + "/ExpressionManager_Settings.json");
            settingsFile.encoding = "UTF-8";
            settingsFile.open("w");
            var saveData = {
                library: expressionLibrary,
                apiSettings: apiSettings,
                uiState: uiState
            };
            settingsFile.write(JSON.stringify(saveData));
            settingsFile.close();
        } catch (e) { }
    }

    // Save/Load Scripts functionality
    function saveScripts() {
        if (typeof JSON === "undefined") return;
        try {
            var settingsFolder = new Folder(Folder.userData.fullName + "/ExpressoSettings");
            if (!settingsFolder.exists) settingsFolder.create();
            var settingsFile = new File(settingsFolder.fullName + "/ExpressionManager_Scripts.json");
            settingsFile.encoding = "UTF-8";
            settingsFile.open("w");
            settingsFile.write(JSON.stringify(scriptLibrary));
            settingsFile.close();
        } catch (e) { }
    }

    function loadScripts() {
        if (typeof JSON === "undefined") { scriptLibrary = []; return; }
        try {
            var settingsFolder = new Folder(Folder.userData.fullName + "/ExpressoSettings");
            var settingsFile = new File(settingsFolder.fullName + "/ExpressionManager_Scripts.json");
            if (settingsFile.exists) {
                settingsFile.encoding = "UTF-8";
                settingsFile.open("r");
                var data = settingsFile.read();
                settingsFile.close();
                scriptLibrary = JSON.parse(data) || [];
            } else { scriptLibrary = []; }
        } catch (e) { scriptLibrary = []; }
    }

    // Script library is loaded inside buildUI via loadScripts() call

    // Show the UI
    var win = buildUI(thisObj);

    if (win instanceof Window) {
        win.center();
        win.show();
    } else {
        win.layout.layout(true);
    }

})(this);
