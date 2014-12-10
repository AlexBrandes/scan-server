/*
 * Scanner.js
 * A simple node app to communicate with a set of Code Scanner 3500 units 
 * and push scans to an API endpoint. 
 *
 * Code Scanner 3500 settings: 
 *		usb keyboard factory reset, save, send and log mode, qr code on, save
 */
(function() {
	var self = this;
	this.HID = require('node-hid');
	this.request = require('request');
	this.config = require('./config');
	this.os = require('os');
	this.activeDevices = {};
	this.scanData = [];
	this.errData = [];
	this.logType = 'console';
	this.loop = null;

	// HID key code mappings
	this.hid_table = {
	  04: 'a', 05: 'b', 06: 'c', 07: 'd', 08: 'e', 09: 'f',
	  10: 'g', 11: 'h', 12: 'i', 13: 'j', 14: 'k', 15: 'l',
	  16: 'm', 17: 'n', 18: 'o', 19: 'p', 20: 'q', 21: 'r',
	  22: 's', 23: 't', 24: 'u', 25: 'v', 26: 'w', 27: 'x',
	  28: 'y', 29: 'z', 30: '1', 31: '2', 32: '3', 33: '4',
	  34: '5', 35: '6', 36: '7', 37: '8', 38: '9', 39: '0',
	  46: '=', 56: '/', 0x2C: ' ',
	  0x33: ';', 0x34: "'", 0x36: ',', 0x37: '.', 0x38: '/'
	};

	// Shift key pressed
	this.shift_hid_table = {
	  04: 'A', 05: 'B', 06: 'C', 07: 'D', 08: 'E', 09: 'F',
	  10: 'G', 11: 'H', 12: 'I', 13: 'J', 14: 'K', 15: 'L',
	  16: 'M', 17: 'N', 18: 'O', 19: 'P', 20: 'Q', 21: 'R',
	  22: 'S', 23: 'T', 24: 'U', 25: 'V', 26: 'W', 27: 'X',
	  28: 'Y', 29: 'Z', 46: '+', 0x2C: ' ',
	  0x33: ':', 0x34: '"', 0x36: '<', 0x37: '>', 0x38: '?'
	};

	this.discoverDevicePaths = function()  {
		// get list of all devices
		var allDevices = self.HID.devices();

		// just get paths of the devices we want
		var code_reader_paths = [];
		for (key in allDevices) {
			var device = allDevices[key];
			if (device.product.search(self.config.input_device) > -1) {
				code_reader_paths.push(device.path);
			}
		}

		// no scanners
		if (code_reader_paths.length == 0) { 
			self.log('No code readers found.');
		}

		return code_reader_paths;
	};

	this.listen = function(device) {
		var text = '';

		device.on('data', function(data) {
			try {
				var keyChar = data[2];
		        var table = (data[0] & 0x2) ? self.shift_hid_table : self.hid_table;

				if (table[keyChar]) text += table[keyChar];
			    else if (keyChar == 40) {
			    	var fields = text.split(self.config.data_separator);

			    	var pushData = {};
			    	for (var i = 0; i < self.config.data_fields.length; i++) {
			    		var key = self.config.data_fields[i];
			    		pushData[key] = fields[0];
			    	}
			    	self.scanData.push(pushData);

			    	text = '';
			    }
			}
			catch (error) {
				log(error);
			}
		});

		device.on('error', function(err) {
			self.log('error with device. Removing from active list.');
			delete(self.activeDevices[device.path]);
			var totalScanners = Object.keys(self.activeDevices).length;
			self.log('Listening to '+totalScanners+' scanner'+(totalScanners !== 1 ? 's' : '')+'.');
			self.log(err);
		});
	};

	this.pushDataToApi = function() {
		var formData = self.scanData;
		self.scanData = [];

		// resend errored out data
		if (self.errData.length > 0) {
			formData = self.errData.concat(formData);
			self.errData = [];
		}

		// post the data
		self.log(getTimestamp()+' Sending '+formData.length+' scans to server.');
		self.request.post({
			url: self.config.api_endpoint,
			formData: {
				status: formData.length == 0 ? 'no data' : 'has data',
				data: formData
			}
		}, function(err, httpResponse, body) {
			if (err) {
				self.errData = self.errData.concat(formData);
				self.log(getTimestamp()+' Send error:');
				self.log(err);
			}
			else {
				self.log('Successful response');
			}
		});
	};

	this.getTimestamp = function() {
		var now = new Date();

		var minutes = now.getMinutes();

		var timestamp = '';
		timestamp += now.getFullYear()+'/';
		timestamp += (now.getMonth() + 1)+'/';
		timestamp += now.getDate()+ ' ';
		timestamp += now.getHours()+':';
		timestamp += (new String(minutes).length == 1 ? '0'+minutes : minutes)+':';
		timestamp += now.getSeconds();

		return timestamp;
	};

	this.updateDevices = function() {
		// find new scanners
		var devicePaths = self.discoverDevicePaths();

		for (key in devicePaths) {
			var path = devicePaths[key];

			// add new devices
			if (! self.activeDevices[path]) {
				try {
					var hidDevice = new self.HID.HID(path);
					hidDevice.path = path;
					self.activeDevices[path] = hidDevice;
					listen(self.activeDevices[path]);

					self.log('Scanner located.');
					var totalScanners = Object.keys(self.activeDevices).length;
					self.log('Listening to '+totalScanners+' scanner'+(totalScanners > 1 ? 's' : '')+'.');
				}
				catch (err) {
					self.log('could not open device at path '+path); 
					self.log(err);
				}
			}
		}
	};

	this.log = function(content) {
		var logType = self.logType || 'file';

		if (logType == 'console') {
			console.log(content);
		}
	};

	this.run = function() {
		self.log('Spinning up scanner server. Current machine has hostname: '+self.os.hostname());

		// initial device search
		self.updateDevices();

		// Server ping loop
		var interval = setInterval(function() {
			// send any existing data
			self.pushDataToApi();

			self.updateDevices();
		}, (self.config.send_frequency * 1000));

		return interval;
	};

	self.loop = self.run();
})();
