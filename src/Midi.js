import * as Decoder from 'midi-file-parser'
import * as Encoder from 'jsmidgen'
import * as Util from './Util'
import {Track} from './Track'
import {Control} from './Control'
import {BinaryInsert} from './BinaryInsert'
import {parseHeader} from './Header'

/**
 * @class The Midi object. Contains tracks and the header info.
 */
class Midi {
	/**
	 * Convert JSON to Midi object
	 * @param {object} json
	 * @static
	 * @returns {Midi}
	 */
	static fromJSON(json){
		var midi = new Midi()

		midi.header = json.header
		json.tracks.forEach((track) => {
			var newTrack = Track.fromJSON(track)
			midi.tracks.push(newTrack)
		})

		return midi
	}

	constructor(){

		this.header = {
			//defaults
			bpm : 120,
			timeSignature : [4, 4],
			PPQ : 480
		}

		this.tracks = []
	}

	/**
	 * Load the given url and parse the midi at that url
	 * @param  {String}   url
	 * @param {*} data Anything that should be sent in the XHR
	 * @param {String} method Either GET or POST
	 * @return {Promise}
	 */
	load(url, data=null, method='GET'){
		return new Promise((success, fail) => {
			var request = new XMLHttpRequest()
			request.open(method, url)
			request.responseType = 'arraybuffer'
			// decode asynchronously
			request.addEventListener('load', () => {
				if (request.readyState === 4 && request.status === 200){
					success(this.decode(request.response))
				} else {
					fail(request.status)
				}
			})
			request.addEventListener('error', fail)
			request.send(data)
		}).catch(function(error) {
				console.log(error);
			});
	}

	/**
	 * Decode the bytes
	 * @param  {String|ArrayBuffer} bytes The midi file encoded as a string or ArrayBuffer
	 * @return {Midi}       this
	 */
	decode(bytes){

		if (bytes instanceof ArrayBuffer){
			var byteArray = new Uint8Array(bytes)
			bytes = String.fromCharCode.apply(null, byteArray)
		}

		const midiData = Decoder(bytes)

		this.header = parseHeader(midiData)

		// Tempo changes
		const tempoChanges = []

		// Tracks and channel instruments
		const tracks = []
		const channelInstruments = []

		midiData.tracks.forEach((trackData) => {

			const track = new Track()
			tracks.push(track)

			let channel = -1
			let instrument = -1
			let absoluteTime = 0

			const channelCC = []
			const channelPitchBendRange = []

			trackData.forEach((event) => {
				absoluteTime += Util.ticksToSeconds(event.deltaTime, this.header)
				if (event.channel && track.channelNumber === -1) {
					track.channelNumber = event.channel
				}

				// Keep track of current channel ControlChange
				if (event.type === 'channel' && event.subtype === 'controller' && event.controllerType){
					if (channelCC[event.channel] === undefined){
						channelCC[event.channel] = {}
					}
					channelCC[event.channel][event.controllerType] = event.value
				}

				if (event.type === 'meta' && event.subtype === 'trackName'){
					track.name = Util.cleanName(event.text)
				} else if (event.subtype === 'noteOn'){
					if (track.channelNumber === -1) {
						track.channelNumber = event.channel
					}
					channel = event.channel
					instrument = (channelInstruments[channel] === undefined)?-1:channelInstruments[channel]
					track.noteOn(event.noteNumber, absoluteTime, event.velocity / 127, channel, instrument)
				} else if (event.subtype === 'noteOff'){
					track.noteOff(event.noteNumber, absoluteTime, event.channel)
				} else if (event.subtype === 'controller' && event.controllerType){
					channel = event.channel
					instrument = (channelInstruments[channel] === undefined)?-1:channelInstruments[channel]
					track.cc(event.controllerType, absoluteTime, event.value / 127, channel, instrument)

					// Change pitch bend range
					if (event.controllerType === 6 && channelCC[event.channel] && !channelCC[event.channel][100] && channelCC[event.channel][101] === 0) {
						channelPitchBendRange[event.channel] = event.value
					}
				} else if (event.type === 'meta' && event.subtype === 'instrumentName'){
					channel = event.channel || channel
					const instrumentTrack = new Track()
					instrumentTrack.channelNumber = channel
					instrumentTrack.instrument = event.text
					instrument = instrumentTrack.instrumentNumber
					if (track.instrumentNumber === -1) {
						track.patch(instrument)
					}
					channelInstruments[channel] = instrument
				} else if (event.type === 'meta' && event.subtype === 'setTempo'){
					const newBpm = 60 / (event.microsecondsPerBeat / 1000000)
					const st = new Control(null, absoluteTime, newBpm)
					BinaryInsert(tempoChanges, st)
				} else if (event.type === 'channel' && event.subtype === 'programChange'){
					if (track.instrumentNumber === -1) {
						track.patch(event.programNumber)
					}
					instrument = event.programNumber
					channel = event.channel
					channelInstruments[channel] = instrument
				} else if (event.type === 'channel' && event.subtype === 'pitchBend'){
					let pitchBendRange = channelPitchBendRange[event.channel] || 2
					let pitchBendValue = pitchBendRange * (event.value - 8192) / 8192
					channel = event.channel
					instrument = (channelInstruments[channel] === undefined)?-1:channelInstruments[channel]
					track.cc(event.subtype, absoluteTime, pitchBendValue, channel, instrument)
				}
			})

			//if the track is empty, then it is the file name
			if (!this.header.name && !track.length && track.name) {
				this.header.name = track.name;
			}
		})

		//replace the previous tracks
		this.tracks = []
		let trackId = 0

		// Split mixed tracks into 1 track per channel and instrument
		tracks.forEach((mixedTrack) => {
			const subTracks = []
			const getSubtrack = (channel, instrument) => {
				if (subTracks[channel] === undefined) {
					subTracks[channel] = []
				}
				if (subTracks[channel][instrument] === undefined) {
					subTracks[channel][instrument] = new Track(mixedTrack.name, instrument, channel)
					subTracks[channel][instrument].midiType = midiData.header.formatType
				}
				return subTracks[channel][instrument]
			}

			// Add notes to sub tracks
			mixedTrack.notes.forEach((note) => {
				if (note.channel === -1) {
					note.channel = mixedTrack.channelNumber
				}
				if (note.instrument === -1) {
					note.instrument = mixedTrack.instrumentNumber
					if (note.instrument === -1) {
						note.instrument = 0
					}
				}
				getSubtrack(note.channel, note.instrument).notes.push(note)
			})

			// Add controls to sub tracks
			Object.keys(mixedTrack.controlChanges).forEach((controlType) => {
				mixedTrack.controlChanges[controlType].forEach((cc) => {
					if (cc.channel === -1) {
						cc.channel = mixedTrack.channelNumber
					}
					if (cc.instrument === -1) {
						cc.instrument = mixedTrack.instrumentNumber
						// Drums track without proper instrument set
						if (cc.instrument === -1) {
							cc.instrument = 0
						}
					}
					const trackCc = getSubtrack(cc.channel, cc.instrument).controlChanges
					if (trackCc[controlType] === undefined) {
						trackCc[controlType] = []
					}
					trackCc[controlType].push(cc)
				})
			})

			// Insert sub tracks
			subTracks.forEach((channelTracks) => {
				channelTracks.forEach((track) => {
					track.id = trackId
					this.tracks.push(track)
					trackId++
				})
			})
		})

		// Apply tempo changes
		this.applyTempoChanges(tempoChanges, this.header.bpm);

		return this
	}

	/**
	 * Encode the Midi object as a Buffer String
	 * @returns {String}
	 */
	encode(){
		const output = new Encoder.File({
			ticks : this.header.PPQ
		})

		const firstEmptyTrack = this.tracks.filter(track => !track.length)[0];

		if (this.header.name && !(firstEmptyTrack && firstEmptyTrack.name === this.header.name)) {
			const track = output.addTrack()
			track.addEvent(
				new Encoder.MetaEvent({
					time: 0,
					type: Encoder.MetaEvent.TRACK_NAME,
					data: this.header.name
				})
			)
		}

		this.tracks.forEach((track) => {
			const trackEncoder = output.addTrack()
			trackEncoder.setTempo(this.bpm)

			if (track.name) {
				trackEncoder.addEvent(
					new Encoder.MetaEvent({
						time: 0,
						type: Encoder.MetaEvent.TRACK_NAME,
						data: track.name
					})
				)
			}

			track.encode(trackEncoder, this.header)
		})
		return output.toBytes()
	}

	/**
	 * Convert the output encoding into an Array
	 * @return {Array}
	 */
	toArray(){
		const encodedStr = this.encode()
		const buffer = new Array(encodedStr.length)
		for (let i = 0; i < encodedStr.length; i++){
			buffer[i] = encodedStr.charCodeAt(i)
		}
		return buffer
	}

	/**
	 *  Convert all of the fields to JSON
	 *  @return  {Object}
	 */
	toJSON(){
		const ret = {
			header: this.header,
			startTime: this.startTime,
			duration: this.duration,
			tracks: (this.tracks || []).map(
				track => track.toJSON()
			)
		}

		if (!ret.header.name)
			ret.header.name = ''

		return ret
	}

	/**
	 * Add a new track.
	 * @param {String=} name Optionally include the name of the track
	 * @returns {Track}
	 */
	track(name){
		const track = new Track(name)
		this.tracks.push(track)
		return track
	}

	/**
	 * Get a track either by it's name or track index
	 * @param  {Number|String} trackName
	 * @return {Track}
	 */
	get(trackName){
		if (Util.isNumber(trackName)){
			return this.tracks[trackName]
		} else {
			return this.tracks.find((t) => t.name === trackName)
		}
	}

	/**
	 * Slice the midi file between the startTime and endTime. Returns a copy of the
	 * midi
	 * @param {Number} startTime
	 * @param {Number} endTime
	 * @returns {Midi} this
	 */
	slice(startTime=0, endTime=this.duration){
		const midi = new Midi()
		midi.header = this.header
		midi.tracks = this.tracks.map((t) => t.slice(startTime, endTime))
		return midi
	}

	/**
	 * Apply tempo changes to the song
	 * @param {Array} changes All tempo changes
	 * @param {Number} bpm Initial song BPM
	 * @returns {Midi} this
	 */
	applyTempoChanges(changes, bpm){
		if (changes.length === 0){
			return this
		}

		const applyTempo = function(elements) {
			if (elements.length === 0){
				return
			}

			let oldTime = 0
			let newTime = 0
			let index = 0
			let speed = 1

			elements.forEach((element) => {
				// Note before actual control: continue
				if (element.time < changes[index].time){
					return
				} else {
					oldTime = changes[index].time
					speed = bpm / changes[index].value
				}

				// Note after next control
				while (changes[index + 1] && (element.time >= changes[index + 1].time)){
					newTime += (changes[index + 1].time - oldTime) * speed
					index++
					oldTime = changes[index].time
					speed = bpm / changes[index].value
				}

				element.time = (element.time - oldTime) * speed + newTime

				if (element.duration !== undefined) {
					element.duration *= speed
				}
			})
		}

		this.tracks.forEach((track) => {
			applyTempo(track.notes)
			Object.keys(track.controlChanges).forEach(function(k) {
				applyTempo(track.controlChanges[k]);
			})
		})

		return this
	}

	/**
	 * the time of the first event
	 * @type {Number}
	 */
	get startTime(){
		const startTimes = this.tracks.map((t) => t.startTime)

		if (!startTimes.length)
			return 0

		return Math.min.apply(Math, startTimes) || 0
	}

	/**
	 * The bpm of the midi file in beats per minute
	 * @type {Number}
	 */
	get bpm(){
		return this.header.bpm
	}
	set bpm(bpm){
		const prevTempo = this.header.bpm
		this.header.bpm = bpm
		//adjust the timing of all the notes
		const ratio = prevTempo / bpm
		this.tracks.forEach((track) => track.scale(ratio))

	}

	/**
	 * The timeSignature of the midi file
	 * @type {Array}
	 */
	get timeSignature(){
		return this.header.timeSignature
	}
	set timeSignature(timeSig){
		this.header.timeSignature = timeSig
	}

	/**
	 * The duration is the end time of the longest track
	 * @type {Number}
	 */
	get duration(){
		const durations = this.tracks.map((t) => t.duration)

		if (!durations.length)
			return 0

		return Math.max.apply(Math, durations) || 0
	}
}

export {Midi}
