.PHONY : install deploy githook

install:
	yarn install

deploy: install

githook:
	echo 'HOOK!'
