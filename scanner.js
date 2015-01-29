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
	var request = require('request');
	var fs = require('fs');
	var os = require('os');
	var prompt = require('prompt');
	var RSVP = require('rsvp');

	this.HID = require('node-hid');
	this.config = require('./config');
	this.activeDevices = {};
	this.scanData = [];
	this.errData = [];
	this.loop = null;
	this.mac = null;
	this.sendErrorCount = 0;

	var ExitError = {};

	/*
	 *  DEAL WITH COMMAND LINE INPUTS
	 */
	this.hasArguments = function() {
		return process.argv.length > 2;
	};

	this.processArguments = function() {
		var i = 0;
		for (var i=0; i < process.argv.length; i++) {
			if ([0,1].indexOf(i) > -1) {
				i++;
				continue;
			}

			var val = process.argv[i];

			switch(val) {
				case 'devices':
				case '--devices':
				case '-d':
					console.log(self.HID.devices());
					throw ExitError;
				break;

				case 'hostname':
				case '--hostname':
				case '-ho':
					console.log(os.hostname());
					throw ExitError;
				break;

				case 'config':
				case '--config':
				case '-c':
					console.log(self.config);
					throw ExitError;
				break;

				case 'help':
				case '--help':
				case '-h':
					console.log('\n  SCANNER.JS CODE READER 3500 SCAN SERVER');
					console.log('  Written by Alex Brandes 2014.\n')
					console.log('  USE: sudo node scanner [options]');
					console.log('  OPTIONS ARE ONE OF: ');
					console.log('\t[none]   -> start the scan server');
					console.log('\tdevices  -> list all connected usb devices');
					console.log('\thostname -> display the machine\'s hostname');
					console.log('\tconfig   -> dump app configuration');

					throw ExitError;
				break

				case 'logtype':
				case '--logtype':
				case '-l':
					var nextIndex = i+1;
					self.config.logType = process.argv[nextIndex];
					console.log('log type set to '+self.config.logType);
					return false;
				break

				case '--clear-logs':
				case 'clear-logs':
					var logs = ['debug_log', 'scan_log', 'error_log'];

					for (var i=0; i < logs.length; i++) {
						var log = logs[i];
						fs.writeFile(config[log], '', function(err) {
							if (err) console.log('could not write to '+log);
						});
					}

					throw ExitError;
				break

				default: 
					throw new Error(val+' is not a valid argument.');
			}

			i++;
		};
	};

	if (this.hasArguments()) {
		try {
			this.processArguments();
		}
		catch (err) {
			if (err == ExitError) return;
			console.log('Process arguments error: ');
			console.log(err);
		}
	}

	/*
	 *  RUN SCANNER SERVER
	 */

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
			if (device.product !== 'undefined' && device.product.search(self.config.input_device) > -1) {
				code_reader_paths.push(device.path);
			}
		}

		// no scanners
		if (code_reader_paths.length == 0) { 
			self.log('info', 'No code readers found.');
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

				// 40 is buffer end signal
			    else if (keyChar == 40) {
			    	self.log('scan', text);
			    	var fields = text.split(self.config.data_separator);

			    	var pushData = {};
			    	for (var i = 0; i < self.config.data_fields.length; i++) {
			    		var key = self.config.data_fields[i];
			    		pushData[key] = fields[i];
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
			self.log('error', 'error with device. Removing from active list.');
			self.log('error', err);



			delete(self.activeDevices[device.path]);
			var totalScanners = Object.keys(self.activeDevices).length;
			self.log('info', 'Listening to '+totalScanners+' scanner'+(totalScanners !== 1 ? 's' : '')+'.');
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

		var endpoint = self.config.api_endpoints[self.config.env];

		var postData = {
			url: endpoint,
			formData: {
				requestType: formData.length == 0 ? 'ping' : 'data',
				hostname: self.hostname,
				macAddress: self.mac,
				data: JSON.stringify(formData)
			}
		};

		// post the data
		self.log('info', 'Sending '+formData.length+' scans to server.');

		var sendRequest = function(resolve, reject) {
			request.post(postData, function(err, httpResponse, body) {
				if (err) {
					self.sendErrorCount++;
					self.errData = self.errData.concat(formData);
					self.log('error', 'send error to '+postData.url);
					self.log('error', err);

					// if no sends for 5 cycles, reset wifi
					if (self.sendErrorCount > 5) {
						self.log('error', '5 send errors, resetting wifi.');
						self.resetWifi();
						self.sendErrorCount = 0;
					}

					reject(httpResponse);
				}
				else {
					self.log('info', 'Successful response');
					resolve(body);
				}
			});
		};

		var response =  new RSVP.Promise(sendRequest);

		return response;
	};

	this.resetWifi = function() {
		self.log('error', 'Resetting wifi');
		var childProcess = require('child_process');
		var exec = childProcess.exec;
		exec(__dirname+'/scripts/reset-wifi.sh', function() {
			self.log('error', 'Reset WIFI execution finished.');
		});
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

					self.log('info', 'Scanner located.');
					var totalScanners = Object.keys(self.activeDevices).length;
					self.log('info', 'Listening to '+totalScanners+' scanner'+(totalScanners > 1 ? 's' : '')+'.');
				}
				catch (err) {
					self.log('error', err);
					console.log(self.activeDevices);
				}
			}
		}
	};

	this.getTimestamp = function() {
		var now = new Date();

		var minutes = now.getMinutes();
		var seconds = now.getSeconds();

		var timestamp = '';
		timestamp += now.getFullYear()+'/';
		timestamp += (now.getMonth() + 1)+'/';
		timestamp += now.getDate()+ ' ';
		timestamp += now.getHours()+':';
		timestamp += (new String(minutes).length == 1 ? '0'+minutes : minutes)+':';
		timestamp += (new String(seconds).length == 1 ? '0'+seconds : seconds);

		return timestamp;
	};

	this.log = function(type, content) {
		var logType = self.config.logType || 'file';
		var timestamp = self.getTimestamp();

		if (type == 'info' || type == 'error'){
			switch (logType) {
				case 'console':
					console.log(type.toUpperCase()+': '+timestamp+' '+content);
				break;

				// file
				default:
					var timestamp = self.getTimestamp();

					var logpath;
					if (type == 'error') {
						logpath = fs.realpathSync(__dirname+'/'+self.config.error_log);
					}
					else {
						logpath = fs.realpathSync(__dirname+'/'+self.config.debug_log);
					}

					fs.appendFile(logpath, type.toUpperCase()+': '+timestamp+' '+content+'\n', function(err) {
						if (err) {
							console.log('There was an error writing to log file.');
							console.log(err);
						}
					});
				break;
			}
		}
		else if (type == 'scan') {
			var scanLogPath = fs.realpathSync(__dirname+'/'+self.config.scan_log);
			fs.appendFile(scanLogPath, timestamp+' -- '+content+'\n', function(err) {
				if (err) {
					console.log('There was an error writing to scan log file.');
					console.log(err);
				}
			});
		}
		
	};

	self.exit = function(code) {
		var code = typeof code === 'undefined' ? 0 : code;

		process.exit(code);

		// if we're still here after exit, force an abort
		setTimeout(function() {
			process.abort();
		}, 1000);
		return;
	};

	this.run = function() {
		self.hostname = os.hostname();
		require('getmac').getMac(function(err,mac) {
			if (! err) {
				self.mac = mac;
			} 
		});

		self.log('info', 'Spinning up scanner server. Current machine has hostname: '+self.hostname);

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

	this.showPrompt  = function() {
		prompt.start();
		prompt.message = 'Available commands';
		prompt.delimiter = ' ';

		prompt.get(['exit dump-devices dump-config hostname'], function(err, result) {
			if (err) {
				if (err == 'Error: canceled') {
					self.cleanup();
				}
				else {
					console.log('prompt error:'+err);
				}
			}
			else {
				for (key in result) {
					var input = result[key];

					switch (input) {
						case 'exit':
							self.cleanup();
						break

						case 'dump-config':
							console.log('Config: ');
							console.log(self.config);
							self.showPrompt();
						break

						case 'dump-devices':
							console.log('Active devices: ');
							console.log(Object.keys(self.activeDevices));
							self.showPrompt();
						break;

						case 'hostname':
							console.log('Hostname: '+os.hostname());
							self.showPrompt();
						break;

						default:
							console.log('invalid entry');
							self.showPrompt();
					}
				}
			}
		})
	};

	this.cleanup = function() {
		console.log('cleaning up...');

		// close all devices
		for (key in self.activeDevices) {
			var device = activeDevices[key];
			device.close();
		}

		console.log('Sending final data.');
		clearInterval(self.loop);
		
		self.pushDataToApi().then(function() {
			console.log('Final data sent. Exiting.');
			self.exit(0);
			return;
		}, 
		function() {
			console.log('Final data send error: not sent. All scans are available in the scan log. Exiting.');
			self.exit(0);
		});
	};

	console.log('Scan server running...');
	self.loop = self.run();

	// so the program will not close instantly on exit events
	process.stdin.resume();

	// catches ctrl+c event
	process.on('SIGINT', self.cleanup);

	// allow command line options
	self.showPrompt();
})();
