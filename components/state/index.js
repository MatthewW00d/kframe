// Singleton state definition.
var State = {
  initialState: {},
  handlers: {},
  computeState: function () { /* no-op */ }
};

AFRAME.registerState = function (definition) {
  AFRAME.utils.extend(State, definition);
}

AFRAME.registerSystem('state', {
  init: function () {
    this.diff = {};
    this.state = AFRAME.utils.clone(State.initialState);
    this.subscriptions = [];
    this.initEventHandlers();

    this.lastState = AFRAME.utils.clone(this.state);

    this.eventDetail = {
      lastState: this.lastState,
      state: this.state
    };

    this.el.addEventListener('loaded', () => {
      var i;
      // Initial dispatch.
      for (i = 0; i < this.subscriptions.length; i++) {
        this.subscriptions[i].onStateUpdate(this.state, '@@INIT', {});
      }
    });
  },

  /**
   * Dispatch action.
   */
  dispatch: function (actionName, payload) {
    var i;
    var key;
    var subscription;

    // Modify state.
    State.handlers[actionName](this.state, payload);

    // Post-compute.
    State.computeState(this.state);

    // Get a diff to optimize bind updates.
    for (key in this.diff) { delete this.diff[key]; }
    AFRAME.utils.diff(this.lastState, this.state, this.diff);

    // Store last state.
    this.copyState(this.lastState, this.state);

    // Notify subscriptions / binders.
    for (i = 0; i < this.subscriptions.length; i++) {
      if (!this.shouldUpdate(this.subscriptions[i].keysToWatch, this.diff)) { continue; }
      this.subscriptions[i].onStateUpdate(this.state, actionName, payload);
    }

    // Emit.
    this.eventDetail.action = actionName;
    this.eventDetail.payload = payload;
    this.el.emit('stateupdate', this.eventDetail);
  },

  /**
   * Store last state through a deep extend, but not for arrays.
   */
  copyState: function (lastState, state) {
    var key;

    for (key in state) {
      // Nested state.
      if (state[key] && state[key].constructor === Object) {
        if (!(key in lastState)) {
          // Clone object if destination does not exist.
          lastState[key] = AFRAME.utils.clone(state[key]);
          continue;
        }
        // Recursively copy state.
        this.copyState(lastState[key], state[key]);
        continue;
      }

      // Copy by value.
      lastState[key] = state[key];
    }
  },

  subscribe: function (component) {
    this.subscriptions.push(component);
  },

  unsubscribe: function (component) {
    this.subscriptions.splice(this.subscriptions.indexOf(component), 1);
  },

  /**
   * Check if state changes were relevant to this binding. If not, don't call.
   */
  shouldUpdate: function (keysToWatch, diff) {
    var stateKey;
    for (stateKey in diff) {
      if (keysToWatch.indexOf(stateKey) !== -1) {
        return true;
      }
    }
    return false;
  },

  /**
   * Proxy events to action dispatches so components can just bubble actions up as events.
   * Handlers define which actions they handle. Go through all and add event listeners.
   */
  initEventHandlers: function () {
    var actionName;
    var registeredActions = [];
    var self = this;

    registerListener = registerListener.bind(this);

    // Use declared handlers to know what events to listen to.
    for (actionName in State.handlers) {
      // Only need to register one handler for each event.
      if (registeredActions.indexOf(actionName) !== -1) { continue; }
      registeredActions.push(actionName);
      registerListener(actionName);
    }

    function registerListener (actionName) {
      this.el.addEventListener(actionName, evt => {
        this.dispatch(actionName, evt.detail);
      });
    }
  },

  select: select  // For testing.
});

/**
 * Bind component property to a value in state.
 *
 * bind="geometry.width: car.width""
 * bind__material="color: enemy.color; opacity: enemy.opacity"
 * bind__visible="player.visible"
 */
AFRAME.registerComponent('bind', {
  schema: {
    default: {},
    parse: function (value) {
      // Parse style-like object.
      var data;
      var i;
      var properties;
      var pair;

      // Using setAttribute with object, no need to parse.
      if (value.constructor === Object) { return value; }

      // Using instanced ID as component namespace for single-property component,
      // nothing to separate.
      if (value.indexOf(':') === -1) { return value; }

      // Parse style-like object as keys to values.
      data = {};
      properties = value.split(';');
      for (i = 0; i < properties.length; i++) {
        pair = properties[i].trim().split(':');
        data[pair[0]] = pair[1].trim();
      }
      return data;
    }
  },

  multiple: true,

  init: function () {
    this.system = this.el.sceneEl.systems.state;
    this.keysToWatch = [];
    this.onStateUpdate = this.onStateUpdate.bind(this);

    // Whether we are binding by namespace (e.g., bind__foo="prop1: true").
    this.isNamespacedBind =
      this.id &&
      (this.id in AFRAME.components && !AFRAME.components[this.id].isSingleProp) ||
      this.id in AFRAME.systems;

    this.lastData = {};
    this.updateObj = {};

    // Subscribe to store and register handler to do data-binding to components.
    this.system.subscribe(this);

    this.onStateUpdate(this.system.state);
  },

  update: function () {
    var data = this.data;
    var key;
    var property;

    this.keysToWatch.length = 0;

    // Index `keysToWatch` to only update state on relevant changes.
    if (typeof data === 'string') {
      parseKeysToWatch(this.keysToWatch, data);
      return;
    }
    for (key in data) {
      parseKeysToWatch(this.keysToWatch, data[key]);
    }
  },

  /**
   * Handle state update.
   */
  onStateUpdate: function (state, actionName) {
    // Update component with the state.
    var hasKeys = false;
    var el = this.el;
    var propertyName;
    var stateSelector;
    var value;

    if (this.isNamespacedBind) { clearObject(this.updateObj); }

    // Single-property bind.
    if (typeof this.data !== 'object') {
      try {
        value = select(state, this.data);
      } catch (e) {
        throw new Error(`[aframe-state-component] Key '${this.data}' not found in state.` +
                        ` #${this.el.getAttribute('id')}[${this.attrName}]`);
      }

      if (typeof value !== 'object '&&
          typeof this.lastData !== 'object' &&
          this.lastData === value) { return; }

      AFRAME.utils.entity.setComponentProperty(el, this.id, value);
      this.lastData = value;
      return;
    }

    for (propertyName in this.data) {
      // Pointer to a value in the state (e.g., `player.health`).
      stateSelector = this.data[propertyName].trim();
      try {
        value = select(state, stateSelector);
      } catch (e) {
        throw new Error(`[aframe-state-component] Key '${stateSelector}' not found in state.` +
                        ` #${this.el.getAttribute('id')}[${this.attrName}]`);
      }

      if (typeof value !== 'object' &&
          typeof this.lastData[propertyName] !== 'object' &&
          this.lastData[propertyName] === value) { continue; }

      // Remove component if value is `undefined`.
      if (propertyName in AFRAME.components && value === undefined) {
        el.removeAttribute(propertyName);
        return;
      }

      // Set using dot-delimited property name.
      if (this.isNamespacedBind) {
        // Batch if doing namespaced bind.
        this.updateObj[propertyName] = value;
      } else {
        AFRAME.utils.entity.setComponentProperty(el, propertyName, value);
      }

      this.lastData[propertyName] = value;
    }

    // Batch if doing namespaced bind.
    for (hasKeys in this.updateObj) {
      // See if object is empty.
    }
    if (this.isNamespacedBind && hasKeys) {
      el.setAttribute(this.id, this.updateObj);
    }
  },

  remove: function () {
    this.system.unsubscribe(this);
  }
});

/**
 * Toggle component attach and detach based on boolean value.
 *
 * bind__raycastable="isRaycastable""
 */
AFRAME.registerComponent('bind-toggle', {
  schema: {type: 'string'},

  multiple: true,

  init: function () {
    this.system = this.el.sceneEl.systems.state;
    this.keysToWatch = [];
    this.onStateUpdate = this.onStateUpdate.bind(this);

    // Subscribe to store and register handler to do data-binding to components.
    this.system.subscribe(this);

    this.onStateUpdate(this.system.state);
  },

  update: function () {
    this.keysToWatch.length = 0;
    parseKeysToWatch(this.keysToWatch, this.data);
  },

  /**
   * Handle state update.
   */
  onStateUpdate: function (state, actionName) {
    var el = this.el;
    var value;

    try {
      value = select(state, this.data);
    } catch (e) {
      throw new Error(`[aframe-state-component] Key '${this.data}' not found in state.` +
                      ` #${this.el.getAttribute('id')}[${this.attrName}]`);
    }

    if (value) {
      el.setAttribute(this.id, '');
    } else {
      el.removeAttribute(this.id);
    }
  },

  remove: function () {
    this.system.unsubscribe(this);
  }
});

/**
 * Select value from store.
 *
 * @param {object} state - State object.
 * @param {string} selector - Dot-delimited store keys (e.g., game.player.health).
 */
function select (state, selector) {
  var i;
  var runningBool;
  var tokens;

  // If just single selector, then grab value.
  tokens = selector.split(/\s+/);
  if (tokens.length === 1) { return selectProperty(state, selector); }

  // If has boolean expression, evaluate.
  runningBool = selectProperty(state, tokens[0]);
  for (i = 1; i < tokens.length; i += 2) {
    if (tokens[i] === '||') {
      runningBool = runningBool || selectProperty(state, tokens[i + 1]);
    } else if (tokens[i] === '&&') {
      runningBool = runningBool && selectProperty(state, tokens[i + 1]);
    }
  }
  return runningBool;
}

function selectProperty (state, selector) {
  var i;
  var split;
  var value = state;
  split = stripNot(selector).split('.');
  for (i = 0; i < split.length; i++) {
    value = value[split[i]];
  }
  if (selector[0] === '!' && selector[1] === '!') { return !!value; }
  if (selector[0] === '!') { return !value; }
  return value;
}

function clearObject (obj) {
  var key;
  for (key in obj) { delete obj[key]; }
}

/**
 * Helper to compose object of handlers, merging functions handling same action.
 */
function composeHandlers () {
  var actionName;
  var i;
  var inputHandlers = arguments;
  var outputHandlers;

  outputHandlers = {};
  for (i = 0; i < inputHandlers.length; i++) {
    for (actionName in inputHandlers[i]) {
      if (actionName in outputHandlers) {
        // Initial compose/merge functions into arrays.
        if (outputHandlers[actionName].constructor === Array) {
          outputHandlers[actionName].push(inputHandlers[i][actionName]);
        } else {
          outputHandlers[actionName] = [outputHandlers[actionName], inputHandlers[i][actionName]];
        }
      } else {
        outputHandlers[actionName] = inputHandlers[i][actionName];
      }
    }
  }

  // Compose functions specified via array.
  for (actionName in outputHandlers) {
    if (outputHandlers[actionName].constructor === Array) {
      outputHandlers[actionName] = composeFunctions.apply(this, outputHandlers[actionName])
    }
  }

  return outputHandlers;
}
module.exports.composeHandlers = composeHandlers;

function composeFunctions () {
  var functions = arguments;
  return function () {
    var i;
    for (i = 0; i < functions.length; i++) {
      functions[i].apply(this, arguments);
    }
  }
}
module.exports.composeFunctions = composeFunctions;

function parseKeysToWatch (keys, str) {
  var i;
  var tokens;
  tokens = str.split(/\s+/);
  for (i = 0; i < tokens.length; i++) {
    if (tokens[i] !== '||' && tokens[i] !== '&&') {
      keys.push(parseKeyToWatch(tokens[i]));
    }
  }
}

function parseKeyToWatch (str) {
  var dotIndex;
  str = stripNot(str.trim());
  dotIndex = str.indexOf('.');
  if (dotIndex === -1) { return str; }
  return str.substring(0, str.indexOf('.'));
}

function stripNot (str) {
 if (str.indexOf('!!') === 0) {
    return str.replace('!!', '');
  } else if (str.indexOf('!') === 0) {
    return str.replace('!', '');
  }
  return str;
}
