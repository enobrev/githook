# githook
A stupid simple CI for running makefile commands after github reports new commits

# Provisioning
The `/provision` directory has some sample configuration files for running the server.  

# Configuration
Each package you would like to build should have a githook section in its Makefile.  Githook will then call `make githook` on that directory when the repo is updated.  Of course, you can add whatever you like to that script.  Don't forget to pull the latest from git.
