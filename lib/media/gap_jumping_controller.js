/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.media.GapJumpingController');

goog.require('shaka.log');
goog.require('shaka.media.PresentationTimeline');
goog.require('shaka.media.StallDetector');
goog.require('shaka.media.TimeRangesUtils');
goog.require('shaka.util.EventManager');
goog.require('shaka.util.FakeEvent');
goog.require('shaka.util.IReleasable');
goog.require('shaka.util.Platform');
goog.require('shaka.util.Timer');


/**
 * GapJumpingController handles jumping gaps that appear within the content.
 * This will only jump gaps between two buffered ranges, so we should not have
 * to worry about the availability window.
 *
 * @implements {shaka.util.IReleasable}
 */
shaka.media.GapJumpingController = class {
  /**
   * @param {!HTMLMediaElement} video
   * @param {!shaka.media.PresentationTimeline} timeline
   * @param {shaka.extern.StreamingConfiguration} config
   * @param {shaka.media.StallDetector} stallDetector
   *   The stall detector is used to keep the playhead moving while in a
   *   playable region. The gap jumping controller takes ownership over the
   *   stall detector.
   *   If no stall detection logic is desired, |null| may be provided.
   * @param {function(!Event)} onEvent
   *     Called when an event is raised to be sent to the application.
   */
  constructor(video, timeline, config, stallDetector, onEvent) {
    /** @private {?function(!Event)} */
    this.onEvent_ = onEvent;

    /** @private {HTMLMediaElement} */
    this.video_ = video;

    /** @private {?shaka.media.PresentationTimeline} */
    this.timeline_ = timeline;

    /** @private {?shaka.extern.StreamingConfiguration} */
    this.config_ = config;

    /** @private {shaka.util.EventManager} */
    this.eventManager_ = new shaka.util.EventManager();

    /** @private {boolean} */
    this.started_ = false;

    /** @private {boolean} */
    this.seekingEventReceived_ = false;

    /** @private {number} */
    this.prevReadyState_ = video.readyState;

    /** @private {number} */
    this.startTime_ = 0;

    /** @private {number} */
    this.gapsJumped_ = 0;

    /**
     * The stall detector tries to keep the playhead moving forward. It is
     * managed by the gap-jumping controller to avoid conflicts. On some
     * platforms, the stall detector is not wanted, so it may be null.
     *
     * @private {shaka.media.StallDetector}
     */
    this.stallDetector_ = stallDetector;

    /** @private {boolean} */
    this.hadSegmentAppended_ = false;

    this.eventManager_.listen(video, 'waiting', () => this.onPollGapJump_());

    /**
     * We can't trust |readyState| or 'waiting' events on all platforms. To make
     * up for this, we poll the current time. If we think we are in a gap, jump
     * out of it.
     *
     * See: https://bit.ly/2McuXxm and https://bit.ly/2K5xmJO
     *
     * @private {?shaka.util.Timer}
     */
    this.gapJumpTimer_ = new shaka.util.Timer(() => {
      this.onPollGapJump_();
    });
  }


  /** @override */
  release() {
    if (this.eventManager_) {
      this.eventManager_.release();
      this.eventManager_ = null;
    }

    if (this.gapJumpTimer_ != null) {
      this.gapJumpTimer_.stop();
      this.gapJumpTimer_ = null;
    }

    if (this.stallDetector_) {
      this.stallDetector_.release();
      this.stallDetector_ = null;
    }

    this.onEvent_ = null;
    this.timeline_ = null;
    this.video_ = null;
  }


  /**
   * Called when a segment is appended by StreamingEngine, but not when a clear
   * is pending. This means StreamingEngine will continue buffering forward from
   * what is buffered.  So we know about any gaps before the start.
   */
  onSegmentAppended() {
    this.hadSegmentAppended_ = true;
    this.onPollGapJump_();
  }

  /**
   * Called when playback has started and the video element is
   * listening for seeks.
   *
   * @param {number} startTime
   */
  onStarted(startTime) {
    this.started_ = true;
    if (this.video_.seeking && !this.seekingEventReceived_) {
      this.seekingEventReceived_ = true;
      this.startTime_ = startTime;
    }
    if (this.gapJumpTimer_) {
      this.gapJumpTimer_.tickEvery(this.config_.gapJumpTimerTime);
    }
    this.onPollGapJump_();
  }

  /** Called when a seek has started. */
  onSeeking() {
    this.seekingEventReceived_ = true;
    this.hadSegmentAppended_ = false;
    this.onPollGapJump_();
  }


  /**
   * Returns the total number of playback gaps jumped.
   * @return {number}
   */
  getGapsJumped() {
    return this.gapsJumped_;
  }


  /**
   * Called on a recurring timer to check for gaps in the media.  This is also
   * called in a 'waiting' event.
   *
   * @private
   */
  onPollGapJump_() {
    // Don't gap jump before the video is ready to play.
    if (this.video_.readyState == 0) {
      return;
    }
    // Don't gap jump before playback started
    if (!this.started_) {
      return;
    }
    // Do not gap jump if seeking has begun, but the seeking event has not
    // yet fired for this particular seek.
    if (this.video_.seeking) {
      if (!this.seekingEventReceived_) {
        return;
      }
    } else {
      this.seekingEventReceived_ = false;
    }
    // Don't gap jump while paused, so that you don't constantly jump ahead
    // while paused on a livestream.  We make an exception for time 0, since we
    // may be _required_ to seek on startup before play can begin, but only if
    // autoplay is enabled.
    if (this.video_.paused && (this.video_.currentTime != this.startTime_ ||
      (!this.video_.autoplay && this.video_.currentTime == this.startTime_))) {
      return;
    }


    // When the ready state changes, we have moved on, so we should fire the
    // large gap event if we see one.
    if (this.video_.readyState != this.prevReadyState_) {
      this.prevReadyState_ = this.video_.readyState;
    }

    if (this.stallDetector_ && this.stallDetector_.poll()) {
      // Some action was taken by StallDetector, so don't do anything yet.
      return;
    }


    const currentTime = this.video_.currentTime;
    const buffered = this.video_.buffered;
    const gapDetectionThreshold = this.config_.gapDetectionThreshold;

    const gapIndex = shaka.media.TimeRangesUtils.getGapIndex(
        buffered, currentTime, gapDetectionThreshold);

    // The current time is unbuffered or is too far from a gap.
    if (gapIndex == null) {
      return;
    }

    // If we are before the first buffered range, this could be an unbuffered
    // seek.  So wait until a segment is appended so we are sure it is a gap.
    if (gapIndex == 0 && !this.hadSegmentAppended_) {
      return;
    }

    // StreamingEngine can buffer past the seek end, but still don't allow
    // seeking past it.
    let jumpTo = buffered.start(gapIndex);
    // Workaround for Xbox with Legacy Edge. On this platform video element
    // often rounds value we want to set as currentTime and we are not able
    // to jump over the gap.
    if (shaka.util.Platform.isLegacyEdge() ||
        shaka.util.Platform.isXboxOne() ||
        shaka.util.Platform.isTizen()) {
      const gapPadding = this.config_.gapPadding;
      jumpTo = Math.ceil((jumpTo + gapPadding) * 100) / 100;
    }
    const seekEnd = this.timeline_.getSeekRangeEnd();
    if (jumpTo >= seekEnd) {
      return;
    }

    const jumpSize = jumpTo - currentTime;

    // If we jump to exactly the gap start, we may detect a small gap due to
    // rounding errors or browser bugs.  We can ignore these extremely small
    // gaps since the browser should play through them for us.
    if (jumpSize < shaka.media.GapJumpingController.BROWSER_GAP_TOLERANCE) {
      return;
    }

    if (gapIndex == 0) {
      shaka.log.info(
          'Jumping forward', jumpSize,
          'seconds because of gap before start time of', jumpTo);
    } else {
      shaka.log.info(
          'Jumping forward', jumpSize, 'seconds because of gap starting at',
          buffered.end(gapIndex - 1), 'and ending at', jumpTo);
    }

    this.video_.currentTime = jumpTo;
    // This accounts for the possibility that we jump a gap at the start
    // position but we jump _into_ another gap. By setting the start
    // position to the new jumpTo we ensure that the check above will
    // pass even though the video is still paused.
    if (currentTime == this.startTime_) {
      this.startTime_ = jumpTo;
    }
    this.gapsJumped_++;
    this.onEvent_(
        new shaka.util.FakeEvent(shaka.util.FakeEvent.EventName.GapJumped));
  }
};


/**
 * The limit, in seconds, for the gap size that we will assume the browser will
 * handle for us.
 * @const
 */
shaka.media.GapJumpingController.BROWSER_GAP_TOLERANCE = 0.001;

