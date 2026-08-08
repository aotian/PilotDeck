#include <iostream>
using namespace std;
int main(){int n,m,r,c;cin>>n>>m>>r>>c;int dr[4]={-1,1,0,0},dc[4]={0,0,-1,1},ans=0;for(int k=0;k<4;k++){int nr=r+dr[k],nc=c+dc[k];if(0<=nr&&nr<n&&0<=nc&&nc<m)ans++;}cout<<ans<<'\n';}
