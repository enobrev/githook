.PHONY : build install githook

build: install

install:
	yarn install

githook:
	echo 'HOOK!'
