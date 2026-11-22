# MMM-Videoplayer

This is a module for [MagicMirror²](https://magicmirror.builders/).

The module is a simple video player for your MagicMirror² setup.

### Screenshot

[![The video](screenshot.png)](http://www.youtube.com/watch?v=7Xp5lOZNERc "MMM-Videoplayer")

The "button" is from [MMM-Modulebar](https://github.com/Snille/MMM-Modulebar), only set up to show that the video pauses and resumes when the module is shown or hidden.

### Installation

In your terminal, go to your MagicMirror² `modules` folder:

```bash
cd ~/MagicMirror/modules
```

Clone this repository:

```bash
git clone https://github.com/Snille/MMM-Videoplayer.git
cd MMM-Videoplayer
```

### Update

In your terminal, go to the module folder and pull the latest changes:

```bash
cd ~/MagicMirror/modules/MMM-Videoplayer
git pull
```

### Configuration

Example config (single local video file):

```javascript
{
  module: 'MMM-Videoplayer',
  position: 'middle_center',
  config: {
    video: "/modules/MMM-Videoplayer/video/mov_bbb.mp4", // Can also be a URL to a mp4 file on the internet.
    loop: true, // Repeat the video.
    autoplay: true, // If set to true, sound (muted by default) has to be muted, otherwise the video will not auto play.
    notification: "VIDEOPLAYER1", // Unique notification string for this player (to be able to play, pause, restart and next from another modules).
  }
},
```

Example config (multi URLs to files on the Internet):

```javascript
{
  module: 'MMM-Videoplayer',
  position: 'middle_center',
  config: {
    videolist: ["https://your.site.com/videos/video1.mp4", "https://your.site.com/videos/video2.mp4", "https://your.site.com/videos/video3.mp4"], // Can also be set to files in the path.
    random: true, // Repeat the videos in random order forever.
    autoplay: true, // If set to true, sound (muted by default) has to be muted, otherwise the video will not auto play.
    notification: "VIDEOPLAYER1", // Unique notification string for this player (to be able to play and pause from another modules).
  }
},
```

Absolute minimum config (will only play the default video file):

```javascript
{
  module: 'MMM-Videoplayer',
  position: 'middle_center',
  config: {
  }
},
```

| Option | Default | Description |
|---|---|---| 
|`video`|`/modules/MMM-Videoplayer/video/mov_bbb.mp4`|The video file to play (may be a URL to a video file as well).|
|`videolist`|none|`Example: ['/modules/MMM-Videoplayer/video/video01.mp4', '/modules/MMM-Videoplayer/video/video02.mp4',... ]` List of video files to play (may be URLs to different video files as well).|
|`loop`|`true`|Loop the video list or not. When the last clip in the list has ended, the played queue is refilled and a new round starts. If set to false, the player simply stops (safely) when the list is finished.<br>Possible values: **true** or **false**|
|`random`|`false`|If set to true, the clips are played in random order. Each clip is played exactly once per round (no repeats until the whole list has been played), then `loop` decides whether a new random round starts.<br>Possible values: **true** or **false**|
|`hideonstart`|false|If set to true, the player hides itself each time a new clip has started playing. If `pauseonhide` is also true, the clip pauses while hidden; when the module is shown again (and `resumeonshow` is true) the clip resumes, and the player hides itself again when the next clip starts. The hide only happens once per clip and never re-triggers itself.<br>Possible values: **true** or **false**|
|`showcontrols`|false|Show the controls or not.<br>Possible values: **true** or **false**|
|`preload`|auto|Preload the video or not see the html-[video](https://www.w3schools.com/tags/tag_video.asp)-tag for more information<br>Possible values: **auto**, **metadata** or **none**|
|`autoplay`|`true`|If set to true, sound (muted by default) has to be muted as well, otherwise the video will not auto play.<br>Possible values: **true** or **false**|
|`muted`|`true`|Mute the sound. If auto play is true, this needs to be true as well, otherwise the video will not auto play.<br>Possible values: **true** or **false**|
|`pauseonhide`|`true`|If true the module pauses the video when hidden. The module remembers that the pause was caused by the hide, so it can be distinguished from a manual pause.<br>Possible values: **true** or **false**|
|`resumeonshow`|`true`|If true the module resumes the video when shown — but only if the pause was caused by the hide itself. A clip paused manually via `TOGGLE` stays paused.<br>Possible values: **true** or **false**|
|`notification`|`VIDEOPLAYER1`|Unique notification string for this player. Send this notification with the payload `"TOGGLE"` to play/pause, `"REPLAY"` to restart the current clip from the beginning, or `"NEXT"` to advance to the next clip in the list.|

### Playback state behaviour

All playlist advancement goes through a single code path: the initial load, the video's `ended` event and the `NEXT` notification all update the current index, the played queue and the `<video>` element in exactly the same way, so the player state can not drift apart from what is on screen.

* **Hide / show:** when the module is hidden (and `pauseonhide` is true) the video pauses and the reason is remembered. When the module is shown again, the video only resumes if it was paused by the hide and `resumeonshow` is true — a manual `TOGGLE` pause is never overridden.
* **REPLAY:** always restarts the *current* clip, even right after the list has looped.
* **End of list:** if the list is finished and `loop` is false, `NEXT` (or a natural `ended`) simply stops the player instead of throwing. With `loop` true the played queue becomes the new playlist.
* **Random:** clips are drawn from the remaining queue, so a clip never repeats within a round; after a full round `loop` decides whether the queue resets.
* **hideonstart:** the module hides once per new clip, after it has started playing. The hide does not re-trigger the pause logic, so no hide/pause loop can occur.

### Development

Run the local test suite (covers the playlist, hide/show and notification state transitions):

```bash
npm install
npm test
```

Lint the code:

```bash
npm run lint
```

### CSS Tricks

If you want to change the size of the player, add the following to your `custom.css` and set the size there.

```css
.MMM-Videoplayer video {
    width: 560px;
    height: 315px;
}
```

If you want to rotate the player 90 degrees and set the size:

```css
.MMM-Videoplayer video {
    width: 560px;
    height: 315px;
    -moz-transform:rotate(90deg);
    -webkit-transform:rotate(90deg);
    -o-transform:rotate(90deg);
    -ms-transform:rotate(90deg);
    transform:rotate(90deg);
}
```

Normally you just need to add the line:

```css
    transform:rotate(90deg);
```

But for compatibility reasons, you can add all of them.

If you set the size to your screen size, the video player will not really fill the whole screen when you rotate it 90 degrees, for example in the `fullscreen_below` region. In that case, you can use:

```css
.MMM-Videoplayer video {
    position: absolute;
    transform:rotate(90deg);
    transform-origin: bottom left;
    width: 100vh;
    height: 100vw;
    margin-top: -100vw;
    object-fit: cover;
}
```

### Notes

Even if the player is hidden, you can still start and stop the video by sending notifications to it.
