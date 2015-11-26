/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* globals AnimationsPanel */

"use strict";

var { classes: Cc, interfaces: Ci, utils: Cu, results: Cr } = Components;

const { Task } = require("devtools/sham/task");
const {
  Heritage, ViewHelpers, WidgetMethods, setNamedTimeout,
  clearNamedTimeout, setConditionalTimeout, clearConditionalTimeout
} = require("devtools/client/shared/widgets/ViewHelpers");

const { promise } = require("devtools/sham/promise");
const EventEmitter = require("devtools/shared/event-emitter");
const { AnimationsFront } = require("devtools/server/actors/animation");

const STRINGS_URI = "chrome://devtools/locale/animationinspector.properties";
const L10N = new ViewHelpers.L10N(STRINGS_URI);

// Global toolbox/inspector, set when startup is called.
var gToolbox, gInspector;

/**
 * Startup the animationinspector controller and view, called by the sidebar
 * widget when loading/unloading the iframe into the tab.
 */
var startup = async function(inspector) {
  gInspector = inspector;
  gToolbox = inspector.toolbox;

  // Don't assume that AnimationsPanel is defined here, it's in another file.
  if (!typeof AnimationsPanel === "undefined") {
    throw new Error("AnimationsPanel was not loaded in the " +
                    "animationinspector window");
  }

  // Startup first initalizes the controller and then the panel, in sequence.
  // If you want to know when everything's ready, do:
  // AnimationsPanel.once(AnimationsPanel.PANEL_INITIALIZED)
  await AnimationsController.initialize();
  await AnimationsPanel.initialize();
};

/**
 * Shutdown the animationinspector controller and view, called by the sidebar
 * widget when loading/unloading the iframe into the tab.
 */
var shutdown = async function() {
  await AnimationsController.destroy();
  // Don't assume that AnimationsPanel is defined here, it's in another file.
  if (typeof AnimationsPanel !== "undefined") {
    await AnimationsPanel.destroy();
  }
  gToolbox = gInspector = null;
};

// This is what makes the sidebar widget able to load/unload the panel.
function setPanel(panel) {
  return startup(panel).catch(e => console.error(e));
}
function destroy() {
  return shutdown().catch(e => console.error(e));
}

/**
 * Get all the server-side capabilities (traits) so the UI knows whether or not
 * features should be enabled/disabled.
 * @param {Target} target The current toolbox target.
 * @return {Object} An object with boolean properties.
 */
var getServerTraits = async function(target) {
  let config = [
    { name: "hasToggleAll", actor: "animations",
      method: "toggleAll" },
    { name: "hasToggleSeveral", actor: "animations",
      method: "toggleSeveral" },
    { name: "hasSetCurrentTime", actor: "animationplayer",
      method: "setCurrentTime" },
    { name: "hasMutationEvents", actor: "animations",
     method: "stopAnimationPlayerUpdates" },
    { name: "hasSetPlaybackRate", actor: "animationplayer",
      method: "setPlaybackRate" },
    { name: "hasSetPlaybackRates", actor: "animations",
      method: "setPlaybackRates" },
    { name: "hasTargetNode", actor: "domwalker",
      method: "getNodeFromActor" },
    { name: "hasSetCurrentTimes", actor: "animations",
      method: "setCurrentTimes" },
    { name: "hasGetFrames", actor: "animationplayer",
      method: "getFrames" }
  ];

  let traits = {};
  for (let {name, actor, method} of config) {
    traits[name] = await target.actorHasMethod(actor, method);
  }

  return traits;
};

/**
 * The animationinspector controller's job is to retrieve AnimationPlayerFronts
 * from the server. It is also responsible for keeping the list of players up to
 * date when the node selection changes in the inspector, as well as making sure
 * no updates are done when the animationinspector sidebar panel is not visible.
 *
 * AnimationPlayerFronts are available in AnimationsController.animationPlayers.
 *
 * Usage example:
 *
 * AnimationsController.on(AnimationsController.PLAYERS_UPDATED_EVENT,
 *                         onPlayers);
 * function onPlayers() {
 *   for (let player of AnimationsController.animationPlayers) {
 *     // do something with player
 *   }
 * }
 */
var AnimationsController = {
  PLAYERS_UPDATED_EVENT: "players-updated",

  initialize: async function() {
    if (this.initialized) {
      await this.initialized.promise;
      return;
    }
    this.initialized = promise.defer();

    this.onPanelVisibilityChange = this.onPanelVisibilityChange.bind(this);
    this.onNewNodeFront = this.onNewNodeFront.bind(this);
    this.onAnimationMutations = this.onAnimationMutations.bind(this);

    let target = gToolbox.target;
    this.animationsFront = new AnimationsFront(target.client, target.form);

    // Expose actor capabilities.
    this.traits = await getServerTraits(target);

    if (this.destroyed) {
      console.warn("Could not fully initialize the AnimationsController");
      return;
    }

    this.startListeners();
    await this.onNewNodeFront();

    this.initialized.resolve();
  },

  destroy: async function() {
    if (!this.initialized) {
      return;
    }

    if (this.destroyed) {
      await this.destroyed.promise;
      return;
    }
    this.destroyed = promise.defer();

    this.stopListeners();
    await this.destroyAnimationPlayers();
    this.nodeFront = null;

    if (this.animationsFront) {
      this.animationsFront.destroy();
      this.animationsFront = null;
    }

    this.destroyed.resolve();
  },

  startListeners: function() {
    // Re-create the list of players when a new node is selected, except if the
    // sidebar isn't visible.
    gInspector.selection.on("new-node-front", this.onNewNodeFront);
    gInspector.sidebar.on("select", this.onPanelVisibilityChange);
    gToolbox.on("select", this.onPanelVisibilityChange);
  },

  stopListeners: function() {
    gInspector.selection.off("new-node-front", this.onNewNodeFront);
    gInspector.sidebar.off("select", this.onPanelVisibilityChange);
    gToolbox.off("select", this.onPanelVisibilityChange);
    if (this.isListeningToMutations) {
      this.animationsFront.off("mutations", this.onAnimationMutations);
    }
  },

  isPanelVisible: function() {
    return gToolbox.currentToolId === "inspector" &&
           gInspector.sidebar &&
           gInspector.sidebar.getCurrentTabID() == "animationinspector";
  },

  onPanelVisibilityChange: function() {
    if (this.isPanelVisible()) {
      this.onNewNodeFront();
    }
  },

  onNewNodeFront: async function() {
    // Ignore if the panel isn't visible or the node selection hasn't changed.
    if (!this.isPanelVisible() ||
        this.nodeFront === gInspector.selection.nodeFront) {
      return;
    }

    let done = gInspector.updating("animationscontroller");

    if (!gInspector.selection.isConnected() ||
        !gInspector.selection.isElementNode()) {
      await this.destroyAnimationPlayers();
      this.emit(this.PLAYERS_UPDATED_EVENT);
      done();
      return;
    }

    this.nodeFront = gInspector.selection.nodeFront;
    await this.refreshAnimationPlayers(this.nodeFront);
    this.emit(this.PLAYERS_UPDATED_EVENT, this.animationPlayers);

    done();
  },

  /**
   * Toggle (pause/play) all animations in the current target.
   */
  toggleAll: function() {
    if (!this.traits.hasToggleAll) {
      return promise.resolve();
    }

    return this.animationsFront.toggleAll().catch(e => console.error(e));
  },

  /**
   * Similar to toggleAll except that it only plays/pauses the currently known
   * animations (those listed in this.animationPlayers).
   * @param {Boolean} shouldPause True if the animations should be paused, false
   * if they should be played.
   * @return {Promise} Resolves when the playState has been changed.
   */
  toggleCurrentAnimations: async function(shouldPause) {
    if (this.traits.hasToggleSeveral) {
      await this.animationsFront.toggleSeveral(this.animationPlayers,
                                               shouldPause);
    } else {
      // Fall back to pausing/playing the players one by one, which is bound to
      // introduce some de-synchronization.
      for (let player of this.animationPlayers) {
        if (shouldPause) {
          await player.pause();
        } else {
          await player.play();
        }
      }
    }
  },

  /**
   * Set all known animations' currentTimes to the provided time.
   * @param {Number} time.
   * @param {Boolean} shouldPause Should the animations be paused too.
   * @return {Promise} Resolves when the current time has been set.
   */
  setCurrentTimeAll: async function(time, shouldPause) {
    if (this.traits.hasSetCurrentTimes) {
      await this.animationsFront.setCurrentTimes(this.animationPlayers, time,
                                                 shouldPause);
    } else {
      // Fall back to pausing and setting the current time on each player, one
      // by one, which is bound to introduce some de-synchronization.
      for (let animation of this.animationPlayers) {
        if (shouldPause) {
          await animation.pause();
        }
        await animation.setCurrentTime(time);
      }
    }
  },

  /**
   * Set all known animations' playback rates to the provided rate.
   * @param {Number} rate.
   * @return {Promise} Resolves when the rate has been set.
   */
  setPlaybackRateAll: async function(rate) {
    if (this.traits.hasSetPlaybackRates) {
      // If the backend can set all playback rates at the same time, use that.
      await this.animationsFront.setPlaybackRates(this.animationPlayers, rate);
    } else if (this.traits.hasSetPlaybackRate) {
      // Otherwise, fall back to setting each rate individually.
      for (let animation of this.animationPlayers) {
        await animation.setPlaybackRate(rate);
      }
    }
  }),

  // AnimationPlayerFront objects are managed by this controller. They are
  // retrieved when refreshAnimationPlayers is called, stored in the
  // animationPlayers array, and destroyed when refreshAnimationPlayers is
  // called again.
  animationPlayers: [],

  refreshAnimationPlayers: async function(nodeFront) {
    await this.destroyAnimationPlayers();

    this.animationPlayers = await this.animationsFront
                                      .getAnimationPlayersForNode(nodeFront);

    // Start listening for animation mutations only after the first method call
    // otherwise events won't be sent.
    if (!this.isListeningToMutations && this.traits.hasMutationEvents) {
      this.animationsFront.on("mutations", this.onAnimationMutations);
      this.isListeningToMutations = true;
    }
  }),

  onAnimationMutations: async function(changes) {
    // Insert new players into this.animationPlayers when new animations are
    // added.
    for (let {type, player} of changes) {
      if (type === "added") {
        this.animationPlayers.push(player);
      }

      if (type === "removed") {
        await player.release();
        let index = this.animationPlayers.indexOf(player);
        this.animationPlayers.splice(index, 1);
      }
    }

    // Let the UI know the list has been updated.
    this.emit(this.PLAYERS_UPDATED_EVENT, this.animationPlayers);
  },

  /**
   * Get the latest known current time of document.timeline.
   * This value is sent along with all AnimationPlayerActors' states, but it
   * isn't updated after that, so this function loops over all know animations
   * to find the highest value.
   * @return {Number|Boolean} False is returned if this server version doesn't
   * provide document's current time.
   */
  get documentCurrentTime() {
    let time = 0;
    for (let {state} of this.animationPlayers) {
      if (!state.documentCurrentTime) {
        return false;
      }
      time = Math.max(time, state.documentCurrentTime);
    }
    return time;
  },

  destroyAnimationPlayers: async function() {
    // Let the server know that we're not interested in receiving updates about
    // players for the current node. We're either being destroyed or a new node
    // has been selected.
    if (this.traits.hasMutationEvents) {
      await this.animationsFront.stopAnimationPlayerUpdates();
    }

    for (let front of this.animationPlayers) {
      await front.release();
    }
    this.animationPlayers = [];
  }
};

EventEmitter.decorate(AnimationsController);
