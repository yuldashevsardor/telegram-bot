# format (string): The format of the conversion
conversion-middleware-failed = Could not convert to {$format}. This is an error on our side: try another format.

conversion-middleware-source-unavailable = This file is no longer available: please send it again.

# formats (string): The formats the conversion failed for, comma separated
conversion-middleware-failed-formats = Could not convert: {$formats}.

# formats (string): The formats whose result is too large to send, comma separated
# maxUploadSizeMb (number): The largest file size the bot sends, in MB
conversion-middleware-too-large = Could not send {$formats}: over {$maxUploadSizeMb} MB. Telegram does not let bots send such files.

# format (string): The format of the button pressed
conversion-middleware-already-sent = {$format} has already been sent: it is above in the chat.

# format (string): The format of the button pressed
conversion-middleware-already-failed = {$format} cannot be made from this file: trying again gives the same.
